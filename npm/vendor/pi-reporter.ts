// Starling global Pi reporter extension.
//
// Installs into ~/.pi/agent/extensions/ so ANY pi process (starling run,
// manual `pi`, `pi --session ...`) reports its live pid↔session mapping to
// ~/.starling/live-sessions/<pid>.json. This closes the mapping gap for
// externally launched pi processes whose cmdline no longer carries the
// session id (pi rewrites argv to bare `pi` at startup).
//
// Design constraints (the producer is the authority on session identity):
//   * Heartbeats are async; session_start alone writes synchronously so a
//     short-lived process cannot exit before publishing its identity.
//   * agent_end starts one detached `starling hook` for auto-archive.
//   * Self-healing: the heartbeat mtime is the liveness proof; monitor
//     treats an entry as dead when its pid is gone (entry removed there).
//   * Session switches (/new, /resume) re-report automatically because
//     session_start fires again with the new identity.
import { appendFile, mkdir, rm } from "node:fs/promises";
// session_start must survive instant process exit (pi -p exits right after
// agent_end); use the sync API only for the identity write.
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.STARLING_HOME || join(homedir(), ".starling");
const DIR = join(HOME, "live-sessions");
const PID = process.pid;
let initializing = false;

function stateFile() {
  return join(DIR, `${PID}.json`);
}

async function report(eventName, ctx) {
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
  } else {
    // Pi owns transcript creation and flushes it before agent_end. Spawn the
    // archive synchronously before the first await so `pi -p` cannot lose it.
    if (eventName === "agent_end") archiveToCatalog(payload);
    await appendFile(file, line + "\n", "utf-8").catch(() => {});
  }
}

// Auto-archive after Pi has persisted the first turn. Detached and fully
// fire-and-forget — must never block pi.
// ponytail: spawns the `starling` binary on PATH (~10ms, detached); if the
// archive needs to be cheaper, inline the catalog+store write here instead.
function archiveToCatalog(payload) {
  if (!payload?.session_id || !payload?.cwd) return;
  const body = JSON.stringify({
    session_id: payload.session_id,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    provider: "pi",
    hook_event_name: "Stop",
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
  pi.on("session_start", (_event, ctx) => void report("session_start", ctx));
  pi.on("before_agent_start", (_event, ctx) => void report("before_agent_start", ctx));
  pi.on("agent_end", (_event, ctx) => void report("agent_end", ctx));
  pi.on("session_shutdown", async () => {
    // Best-effort tombstone: monitor also prunes dead pids, so failure is fine.
    await rm(stateFile(), { force: true }).catch(() => {});
  });
}
