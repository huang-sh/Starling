// Starling global Pi reporter extension.
//
// Installs into ~/.pi/agent/extensions/ so ANY pi process (starling run,
// manual `pi`, `pi --session ...`) reports its live pid↔session mapping to
// ~/.starling/live-sessions/<pid>.json. This closes the mapping gap for
// externally launched pi processes whose cmdline no longer carries the
// session id (pi rewrites argv to bare `pi` at startup).
//
// Design constraints (from first principles — the producer is the only
// authority on session identity):
//   * NEVER block pi: no spawnSync, no sync fs writes. appendFile is async
//     fire-and-forget; every failure is swallowed.
//   * No subprocess: a direct file write is ~µs, vs ~10ms for spawning the
//     starling binary per event.
//   * Self-healing: the heartbeat mtime is the liveness proof; monitor
//     treats an entry as dead when its pid is gone (entry removed there).
//   * Session switches (/new, /resume) re-report automatically because
//     session_start fires again with the new identity.
import { appendFile, mkdir, writeFile, rm } from "node:fs/promises";
// session_start must survive instant process exit (pi -p exits right after
// agent_end); use the sync API only for the identity write.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.STARLING_HOME || join(homedir(), ".starling");
const DIR = join(HOME, "live-sessions");
const PID = process.pid;
let initializing = false;

function stateFile() {
  return join(DIR, `${PID}.json`);
}

async function report(eventName, event, ctx) {
  const payload = {
    schema_version: 1,
    pid: PID,
    event: eventName,
    session_id: ctx?.sessionManager?.getSessionId?.() ?? null,
    transcript_path: ctx?.sessionManager?.getSessionFile?.() ?? null,
    cwd: ctx?.cwd ?? null,
    model: ctx?.model ? `${ctx.model.provider ?? ""}/${ctx.model.id ?? ""}` : null,
    timestamp: new Date().toISOString(),
  };
  if (!payload.session_id) return;
  if (!initializing) {
    initializing = true;
    await mkdir(DIR, { recursive: true }).catch(() => {});
  }
  const file = stateFile();
  const line = JSON.stringify(payload);
  // Rewrite on session_start (identity change), append as heartbeat otherwise.
  // session_start uses sync writes: pi -p / RPC exits immediately after the
  // agent settles, and a pending async write would be lost at process exit.
  if (eventName === "session_start") {
    try {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(file, line + "\n", "utf-8");
    } catch {}
    archiveToCatalog(payload);
  } else {
    await appendFile(file, line + "\n", "utf-8").catch(() => {});
  }
}

// Auto-archive on session start: same cwd-named-catalog behavior codex and
// claude get. Detached and fully fire-and-forget — must never block pi.
// ponytail: spawns the `starling` binary on PATH (~10ms, detached); if the
// archive needs to be cheaper, inline the catalog+store write here instead.
function archiveToCatalog(payload) {
  if (!payload?.session_id || !payload?.cwd) return;
  const body = JSON.stringify({
    session_id: payload.session_id,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    hook_event_name: "SessionStart",
  });
  try {
    const child = spawn("starling", ["hook"], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(body);
    child.unref();
  } catch {}
}

export default function starlingReporter(pi) {
  pi.on("session_start", (event, ctx) => void report("session_start", event, ctx));
  pi.on("before_agent_start", (event, ctx) => void report("before_agent_start", event, ctx));
  pi.on("agent_end", (event, ctx) => void report("agent_end", event, ctx));
  pi.on("session_shutdown", async () => {
    // Best-effort tombstone: monitor also prunes dead pids, so failure is fine.
    await rm(stateFile(), { force: true }).catch(() => {});
  });
}
