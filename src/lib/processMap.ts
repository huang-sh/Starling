/**
 * Robust PID → session mapper (Linux /proc based).
 *
 * Replaces the naive cwd→index-mtime mapping that used to live in runs.ts.
 * Cascade per detected agent process:
 *   1. cmdline basename claude|codex            → provider
 *   2. `--resume <uuid>` on cmdline             → direct session id
 *   3. /proc/<pid>/fd readlinks ending .jsonl   → session id from open file
 *   4. process-tree BFS over children (retry 2-3)
 *   5. cwd + most-recent .jsonl under encoded-cwd dir (last resort)
 *
 * Each target process's own environ is read (/proc/<pid>/environ) so a Starling
 * process running in the default home can still resolve sessions that agents
 * launched under a different CLAUDE_CONFIG_DIR / CODEX_HOME have open.
 */
import { readdirSync, readFileSync, readlinkSync, statSync } from "fs";
import { basename, join } from "path";
import { homedir } from "os";

export type Provider = "claude" | "codex";

export interface MappedSession {
  pid: number;
  provider: Provider;
  project_path?: string;
  file_path?: string;
  session_id?: string;
  home?: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RESUME_RE = /\bresume\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/i;
// A session file's basename is a bare UUID (Claude) or a `rollout-...` payload
// (Codex). Other .jsonl files in the agent home — history.jsonl, todos.jsonl,
// statsig/*.jsonl — must NOT be mistaken for session files.
const SESSION_FILE_RE =
  /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|rollout-.+)\.jsonl$/i;

export function isSessionFilePath(filePath: string): boolean {
  return SESSION_FILE_RE.test(basename(filePath));
}

// --- pure helpers (exported for unit testing) ---

export function parseProcEnviron(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of raw.split("\0")) {
    if (!chunk) continue;
    const eq = chunk.indexOf("=");
    if (eq <= 0) continue;
    out[chunk.slice(0, eq)] = chunk.slice(eq + 1);
  }
  return out;
}

export interface ProcStat {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  utime: number;
  stime: number;
  starttime: number;
}

export function parseProcStat(raw: string): ProcStat | null {
  // Field 2 (comm) is wrapped in parens and may contain spaces/parens, so split
  // on the first '(' and the last ')'.
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 0 || close <= open) return null;
  const pid = Number(raw.slice(0, open).trim());
  const comm = raw.slice(open + 1, close);
  const rest = raw.slice(close + 1).trim().split(/\s+/);
  // After comm: state(0) ppid(1) pgrp(2) session(3) tty(4) tpgid(5) flags(6)
  // minflt(7) cminflt(8) majflt(9) cmajflt(10) utime(11) stime(12) ...
  // ... starttime(19)
  const num = (i: number): number => Number(rest[i]) || 0;
  return {
    pid,
    comm,
    state: rest[0] ?? "",
    ppid: num(1),
    utime: num(11),
    stime: num(12),
    starttime: num(19),
  };
}

export function providerFromCmdline(args: string[]): Provider | null {
  for (const arg of args.slice(0, 4)) {
    const base = basename(arg);
    if (base === "claude" || base === "claude-code") return "claude";
    if (base === "codex") return "codex";
  }
  // Node-launched: `node /path/to/.../claude.js` or wrapper scripts.
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (lower.endsWith("/claude") || lower.includes("/claude.js") || lower.endsWith("/claude-code")) return "claude";
    if (lower.endsWith("/codex") || lower.includes("/codex.js")) return "codex";
  }
  return null;
}

export function extractResumeUuid(args: string[]): string | null {
  const joined = args.join(" ");
  const m = joined.match(RESUME_RE);
  if (m) return m[1]!.toLowerCase();
  return null;
}

export function resolveAgentHome(provider: Provider, environ: Record<string, string>): string {
  if (provider === "claude") {
    const env = environ.CLAUDE_CONFIG_DIR?.trim();
    return env ? expandHome(env) : join(homedir(), ".claude");
  }
  const env = environ.CODEX_HOME?.trim();
  return env ? expandHome(env) : join(homedir(), ".codex");
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function sessionRootForHome(provider: Provider, home: string): string {
  return provider === "claude" ? join(home, "projects") : join(home, "sessions");
}

export function encodeClaudeCwd(cwd: string): string {
  // Claude encodes the project cwd by joining path segments with '-' and the
  // whole thing gets a leading '-': /a/b → -a-b.
  return "-" + cwd.split("/").filter(Boolean).join("-");
}

export function extractSessionIdFromPath(filePath: string): string | null {
  const name = basename(filePath);
  const stripped = name.replace(/\.jsonl$/i, "");
  const m = stripped.match(UUID_RE);
  return m ? m[0]!.toLowerCase() : stripped.toLowerCase();
}

/**
 * Per-scan cache of directory listings + recent-file scans, keyed by directory
 * path. Without this, every agent from the same home re-scans the projects/
 * tree on every monitor tick: 30+ agents × readdir+stat-per-subdir = hundreds
 * of syscalls. The cache lives only for the duration of one
 * `mapProcessesToSessions` call (processes come and go, but the directory
 * layout is stable within a 3s tick).
 */
export interface ResolverCache {
  /** root → list of immediate subdirectory names. */
  rootDirs: Map<string, string[]>;
  /** root → most-recent .jsonl under it (recursive scan result). */
  recentJsonl: Map<string, { path: string; mtime: number } | null>;
  /** dir → most-recent .jsonl directly under it (non-recursive). */
  recentJsonlFlat: Map<string, { path: string; mtime: number } | null>;
  /**
   * root → (session basename lowercased → full path). Built lazily on first
   * findSessionFileById call for that root by readdir'ing every subdir once.
   * On large fleets (3000+ project subdirs) this turns N × O(subdirs) stat
   * scans into one O(total_files) readdir pass + O(1) map lookups.
   */
  fileIndex: Map<string, Map<string, string> | null>;
}

export function createResolverCache(): ResolverCache {
  return { rootDirs: new Map(), recentJsonl: new Map(), recentJsonlFlat: new Map(), fileIndex: new Map() };
}

/**
 * Build a `<basename>.jsonl → full path` index for a root by readdir'ing each
 * immediate subdir once. Returns null if root is unreadable. The index covers
 * files directly under `<root>/<subdir>/` (Claude layout) and `<root>/` itself
 * (Codex layout).
 */
function buildFileIndex(root: string, dirs: string[]): Map<string, string> | null {
  const index = new Map<string, string>();
  // Codex: session files may live directly under root.
  try {
    for (const entry of readdirSync(root)) {
      if (entry.endsWith(".jsonl")) {
        index.set(entry.toLowerCase(), join(root, entry));
      }
    }
  } catch {
    /* root itself unreadable — subdirs may still work */
  }
  // Claude: one subdir per cwd, each holding many `<uuid>.jsonl`.
  for (const d of dirs) {
    if (d === "subagents") continue;
    const subdir = join(root, d);
    let entries: string[];
    try {
      entries = readdirSync(subdir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) {
        index.set(entry.toLowerCase(), join(subdir, entry));
      }
    }
  }
  return index;
}

/**
 * Locate `<root>/<...>/<sessionId>.jsonl`. Claude stores one projects-dir per
 * cwd, so this scans immediate children for a matching filename.
 */
export function findSessionFileById(root: string, sessionId: string, cache?: ResolverCache): string | null {
  const target = sessionId.toLowerCase();
  const targetFile = `${target}.jsonl`;

  // Fast path: use the lazy per-root file index when a cache is available.
  // On large fleets (3000+ subdirs) this avoids one stat() per subdir per
  // lookup — the index is built once per snapshot by readdir'ing each subdir,
  // then every lookup is an O(1) map probe.
  if (cache) {
    let index = cache.fileIndex.get(root);
    if (index === undefined) {
      let dirs = cache.rootDirs.get(root);
      if (!dirs) {
        try {
          dirs = readdirSync(root);
          cache.rootDirs.set(root, dirs);
        } catch {
          cache.fileIndex.set(root, null);
          return null;
        }
      }
      index = buildFileIndex(root, dirs);
      cache.fileIndex.set(root, index);
    }
    if (index) {
      const hit = index.get(targetFile);
      if (hit) return hit;
      // Not in the flat index — try the deeper recursive fallback (isolated
      // homes sometimes nest further than one level).
      return findFileRecursive(root, target, 0);
    }
    return null;
  }

  // No cache: fall back to per-subdir stat scan.
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (d === "subagents") continue;
    const candidate = join(root, d, `${sessionId}.jsonl`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
    }
  }
  // Codex sessions live directly under <home>/sessions/<uuid>.jsonl (no subdir).
  const direct = join(root, `${sessionId}.jsonl`);
  try {
    if (statSync(direct).isFile()) return direct;
  } catch {
    /* ignore */
  }
  // Fallback: nested deeper (isolated homes sometimes nest further). Bounded.
  return findFileRecursive(root, target, 0);
}

function findFileRecursive(dir: string, target: string, depth: number): string | null {
  if (depth > 3) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry === "subagents") continue;
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const nested = findFileRecursive(full, target, depth + 1);
      if (nested) return nested;
    } else if (entry.toLowerCase() === `${target}.jsonl`) {
      return full;
    }
  }
  return null;
}

// --- /proc readers (no-op off Linux) ---

function readCmdline(pid: number): string[] | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    return raw.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function readEnviron(pid: number): Record<string, string> {
  try {
    return parseProcEnviron(readFileSync(`/proc/${pid}/environ`, "utf-8"));
  } catch {
    return {};
  }
}

function readCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function readOpenJsonlFiles(pid: number): string[] {
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const fd of fds) {
    try {
      const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (link.endsWith(".jsonl")) out.push(link);
    } catch {
      /* skip unreadable fd */
    }
  }
  return out;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Process names whose cmdline is worth inspecting for an agent invocation.
 * Stat's comm is truncated to 15 chars, so we match the leading fragment.
 * Most processes on a busy fleet machine aren't agents, so this filter skips
 * the cmdline read for ~95% of PIDs and is the dominant win in the /proc scan.
 */
const AGENT_COMM_PREFIXES = [
  "claude",
  "codex",
  "node",
  "npm",
  "npx",
  "bash",
  "sh",
  "deno",
  "bun",
];

function commMightBeAgent(comm: string): boolean {
  if (!comm) return false;
  // stat comm is basename of the executable, ≤15 chars. Match by prefix so
  // "claude-code" / "node" / "npm" all hit; everything else skips cmdline.
  for (const p of AGENT_COMM_PREFIXES) {
    if (comm === p || comm.startsWith(p)) return true;
  }
  return false;
}

/** Build ppid → children[] over /proc once per scan. */
export function buildChildMap(): Map<number, number[]> {
  const children = new Map<number, number[]>();
  if (process.platform !== "linux") return children;
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return children;
  }
  for (const pidStr of pids) {
    let stat: ProcStat | null = null;
    try {
      stat = parseProcStat(readFileSync(`/proc/${pidStr}/stat`, "utf-8"));
    } catch {
      continue;
    }
    if (!stat) continue;
    const arr = children.get(stat.ppid);
    if (arr) arr.push(stat.pid);
    else children.set(stat.ppid, [stat.pid]);
  }
  return children;
}

interface ResolveContext {
  environ: Record<string, string>;
  home: string;
  root: string;
  cwd: string | null;
  cache?: ResolverCache;
}

function resolveFromResume(ctx: ResolveContext, uuid: string): MappedSession | null {
  const file = findSessionFileById(ctx.root, uuid, ctx.cache);
  if (!file) return null;
  return {
    pid: 0, // filled by caller
    provider: "claude", // filled by caller
    session_id: uuid.toLowerCase(),
    file_path: file,
    home: ctx.home,
    project_path: ctx.cwd ?? undefined,
  };
}

function resolveFromOpenFiles(
  ctx: ResolveContext,
  provider: Provider,
  pid: number
): MappedSession | null {
  // Only consider files that actually look like session files; without this,
  // history.jsonl / todos.jsonl (always open in a Claude home) are accepted as
  // the session and short-circuit the cascade before the cwd fallback runs.
  const files = readOpenJsonlFiles(pid).filter(isSessionFilePath);
  // Prefer files inside this process's home root.
  const inRoot = files.find((f) => f.startsWith(ctx.root));
  const chosen = inRoot ?? files[0];
  if (!chosen) return null;
  const sid = extractSessionIdFromPath(chosen);
  if (!sid) return null;
  return {
    pid,
    provider,
    session_id: sid,
    file_path: chosen,
    home: ctx.home,
    project_path: ctx.cwd ?? undefined,
  };
}

function resolveFromCwdMtime(ctx: ResolveContext, provider: Provider, pid: number): MappedSession | null {
  if (!ctx.cwd) return null;
  // Look under the encoded-cwd dir first (Claude), else scan the whole root.
  // Both scans are cached per directory for the lifetime of one snapshot —
  // without this, 2+ agents from the same home each re-walk the projects/ tree
  // (~150ms per pass on a large fleet).
  const encoded = encodeClaudeCwd(ctx.cwd);
  const dir = join(ctx.root, encoded);
  const flatBest = ctx.cache ? cachedMostRecentJsonl(dir, ctx.cache) : mostRecentJsonl(dir);
  const best = flatBest ?? (ctx.cache ? cachedMostRecentJsonlRecursive(ctx.root, ctx.cache) : mostRecentJsonlRecursive(ctx.root, 0));
  if (!best) return null;
  const sid = extractSessionIdFromPath(best.path);
  if (!sid) return null;
  return {
    pid,
    provider,
    session_id: sid,
    file_path: best.path,
    home: ctx.home,
    project_path: ctx.cwd,
  };
}

function cachedMostRecentJsonl(dir: string, cache: ResolverCache): { path: string; mtime: number } | null {
  const hit = cache.recentJsonlFlat.get(dir);
  if (hit !== undefined) return hit;
  const result = mostRecentJsonl(dir);
  cache.recentJsonlFlat.set(dir, result);
  return result;
}

function cachedMostRecentJsonlRecursive(root: string, cache: ResolverCache): { path: string; mtime: number } | null {
  const hit = cache.recentJsonl.get(root);
  if (hit !== undefined) return hit;
  const result = mostRecentJsonlRecursive(root, 0);
  cache.recentJsonl.set(root, result);
  return result;
}

function mostRecentJsonl(dir: string): { path: string; mtime: number } | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const full = join(dir, entry);
    try {
      const mtime = statSync(full).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: full, mtime };
    } catch {
      /* skip */
    }
  }
  return best;
}

function mostRecentJsonlRecursive(dir: string, depth: number): { path: string; mtime: number } | null {
  if (depth > 2) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (entry === "subagents") continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const nested = mostRecentJsonlRecursive(full, depth + 1);
      if (nested && (!best || nested.mtime > best.mtime)) best = nested;
    } else if (entry.endsWith(".jsonl")) {
      if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs };
    }
  }
  return best;
}

/**
 * Map every running claude/codex process to its session. Returns session_id →
 * info. Linux-only (returns an empty map elsewhere). Pure / in-memory.
 */
/**
 * Single /proc walk producing both the agent list and the ppid → children
 * index. Replaces the old pair of walks (listAgentProcesses + buildChildMap)
 * which together read /proc/<pid>/{stat,cmdline} twice for every PID.
 *
 * Stat is read for every PID (cheap, ~few hundred bytes); cmdline is read
 * only when `comm` suggests the process could be an agent launcher, which
 * filters ~95% of PIDs on a busy fleet machine.
 */
export interface ProcScan {
  agents: { pid: number; provider: Provider; args: string[] }[];
  childMap: Map<number, number[]>;
}

export function scanProcOnce(): ProcScan {
  const agents: { pid: number; provider: Provider; args: string[] }[] = [];
  const childMap = new Map<number, number[]>();
  if (process.platform !== "linux") return { agents, childMap };
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return { agents, childMap };
  }
  for (const pidStr of pids) {
    let stat: ProcStat | null = null;
    try {
      stat = parseProcStat(readFileSync(`/proc/${pidStr}/stat`, "utf-8"));
    } catch {
      continue;
    }
    if (!stat) continue;
    // Build ppid index for every process (cheap; we already have stat).
    const arr = childMap.get(stat.ppid);
    if (arr) arr.push(stat.pid);
    else childMap.set(stat.ppid, [stat.pid]);
    // Conditionally read cmdline based on comm to find agents.
    if (!commMightBeAgent(stat.comm)) continue;
    const pid = stat.pid;
    const args = readCmdline(pid);
    if (!args || args.length === 0) continue;
    const provider = providerFromCmdline(args);
    if (!provider) continue;
    agents.push({ pid, provider, args });
  }
  return { agents, childMap };
}

export async function mapProcessesToSessions(): Promise<Map<string, MappedSession>> {
  const result = new Map<string, MappedSession>();
  if (process.platform !== "linux") return result;

  const { agents: procs, childMap } = scanProcOnce();
  if (procs.length === 0) return result;

  const cache = createResolverCache();
  for (const proc of procs) {
    if (!isPidAlive(proc.pid)) continue;
    const mapped = resolveProcess(proc, childMap, new Set<number>(), cache);
    if (mapped?.session_id && !result.has(mapped.session_id)) {
      result.set(mapped.session_id, mapped);
    }
  }
  return result;
}

function resolveProcess(
  proc: { pid: number; provider: Provider; args: string[] },
  childMap: Map<number, number[]>,
  visited: Set<number>,
  cache: ResolverCache
): MappedSession | null {
  if (visited.has(proc.pid)) return null;
  visited.add(proc.pid);

  const environ = readEnviron(proc.pid);
  const home = resolveAgentHome(proc.provider, environ);
  const root = sessionRootForHome(proc.provider, home);
  const cwd = readCwd(proc.pid);
  const ctx: ResolveContext = { environ, home, root, cwd, cache };

  // 1. open .jsonl files via /proc/<pid>/fd — cheap (O(open fds)) and almost
  // always succeeds for a running agent (the session file is held open for
  // appending). Tried BEFORE the --resume lookup because that lookup scans
  // thousands of project subdirs on large fleets (~60ms per call here).
  const fromFd = resolveFromOpenFiles(ctx, proc.provider, proc.pid);
  if (fromFd) return fromFd;

  // 2. --resume <uuid> on cmdline — precise but expensive (subdir scan).
  // Only reached when the fd scan missed (rare for live agents).
  const uuid = extractResumeUuid(proc.args);
  if (uuid) {
    const hit = resolveFromResume(ctx, uuid);
    if (hit) return { ...hit, pid: proc.pid, provider: proc.provider };
  }

  // 3. process-tree BFS over children
  const children = childMap.get(proc.pid) ?? [];
  for (const childPid of children) {
    if (visited.has(childPid)) continue;
    const childArgs = readCmdline(childPid);
    if (!childArgs) continue;
    const childProc = { pid: childPid, provider: proc.provider, args: childArgs };
    const childHit = resolveProcess(childProc, childMap, visited, cache);
    if (childHit) return childHit;
  }

  // 4. cwd + most-recent .jsonl (last resort)
  return resolveFromCwdMtime(ctx, proc.provider, proc.pid);
}
