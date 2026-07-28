import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const RUNS_VERSION = 1;
const MAX_RUN_RECORDS = 500;
const RUNS_LOCK_TIMEOUT_MS = 5_000;
const RUNS_LOCK_RETRY_MS = 5;
const RUNS_LOCK_STALE_MS = 30_000;
/**
 * Register a same-process Pi SDK workspace in Starling's regular run store.
 *
 * The JSON shape deliberately mirrors Rust's RunRecord. Unknown providers,
 * statuses, and future fields are preserved whenever this module rewrites the
 * shared file, so an older Node package cannot erase newer Rust data.
 */
export async function createManagedRun(options) {
    const environment = options.environment ?? process.env;
    const runsPath = await resolveRunsPath(environment);
    const runId = options.runId ?? randomUUID();
    const now = options.now ?? (() => new Date());
    const startedAt = now().toISOString();
    let finishPromise;
    const record = {
        run_id: runId,
        provider: "pi",
        project_path: path.resolve(options.cwd),
        pid: options.pid ?? process.pid,
        status: "running",
        started_at: startedAt,
        source: "starling-run",
    };
    await mutateRuns(runsPath, (runs) => {
        const index = runs.findIndex((candidate) => candidate.run_id === runId);
        if (index >= 0)
            runs[index] = record;
        else
            runs.push(record);
    });
    return {
        runId,
        async updateSession(patch) {
            if (finishPromise)
                return;
            const sessionId = nonEmpty(patch.sessionId);
            const sessionFile = nonEmpty(patch.sessionFile);
            const model = nonEmpty(patch.model);
            const title = nonEmpty(patch.title);
            if (!sessionId && !sessionFile && !model && !title)
                return;
            await mutateRuns(runsPath, (runs) => {
                const existing = runs.find((candidate) => candidate.run_id === runId);
                if (!existing)
                    return;
                if (sessionId)
                    existing.session_id = sessionId;
                if (sessionFile)
                    existing.session_file = sessionFile;
                if (model)
                    existing.model = model;
                if (title)
                    existing.title = title;
            });
        },
        async finish(patch) {
            finishPromise ??= mutateRuns(runsPath, (runs) => {
                const existing = runs.find((candidate) => candidate.run_id === runId);
                if (!existing)
                    return;
                existing.status = patch.exitCode === 0 ? "completed" : "errored";
                existing.exit_code = patch.exitCode;
                existing.ended_at = now().toISOString();
            });
            await finishPromise;
        },
    };
}
export async function resolveRunsPath(environment = process.env) {
    if (environment.STARLING_RUNS !== undefined) {
        return expandHome(environment.STARLING_RUNS, environment);
    }
    const explicitHome = nonEmpty(environment.STARLING_HOME);
    if (explicitHome)
        return path.join(expandHome(explicitHome, environment), "runs.json");
    const configDir = path.join(userHome(environment), ".config", "starling");
    const configPath = nonEmpty(environment.STARLING_CLI_CONFIG)
        ? expandHome(environment.STARLING_CLI_CONFIG, environment)
        : path.join(configDir, "config.json");
    const configuredHome = await readConfiguredHome(configPath);
    if (configuredHome) {
        return path.join(expandHome(configuredHome, environment), "runs.json");
    }
    return path.join(configDir, "runs.json");
}
async function mutateRuns(runsPath, mutate) {
    const directory = path.dirname(runsPath);
    await mkdir(directory, { recursive: true });
    const lock = await acquireRunsLock(runsPath);
    let temporaryPath;
    try {
        const data = await readRuns(runsPath);
        mutate(data.runs);
        data.version = RUNS_VERSION;
        data.runs = trimRuns(data.runs);
        temporaryPath = path.join(directory, `.${path.basename(runsPath)}.${process.pid}.${randomUUID()}.tmp`);
        await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        await rename(temporaryPath, runsPath);
        temporaryPath = undefined;
    }
    finally {
        if (temporaryPath)
            await unlink(temporaryPath).catch(() => { });
        await lock.release();
    }
}
/** Serialize read-modify-write updates across independent bare Starling processes. */
async function acquireRunsLock(runsPath) {
    const lockPath = `${runsPath}.lock`;
    const owner = {
        token: randomUUID(),
        pid: process.pid,
        createdAt: Date.now(),
    };
    const deadline = Date.now() + RUNS_LOCK_TIMEOUT_MS;
    while (true) {
        try {
            const handle = await open(lockPath, "wx", 0o600);
            try {
                await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
            }
            catch (error) {
                await handle.close().catch(() => { });
                await unlink(lockPath).catch(() => { });
                throw error;
            }
            let released = false;
            return {
                async release() {
                    if (released)
                        return;
                    released = true;
                    await handle.close().catch(() => { });
                    try {
                        const current = parseLockOwner(await readFile(lockPath, "utf8"));
                        if (current?.token === owner.token)
                            await unlink(lockPath);
                    }
                    catch (error) {
                        if (!isNodeError(error) || error.code !== "ENOENT")
                            throw error;
                    }
                },
            };
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== "EEXIST")
                throw error;
            await removeStaleRunsLock(lockPath);
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for Starling run lock: ${lockPath}`);
            }
            await delay(RUNS_LOCK_RETRY_MS);
        }
    }
}
async function removeStaleRunsLock(lockPath) {
    let raw;
    try {
        raw = await readFile(lockPath, "utf8");
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return;
        throw error;
    }
    const owner = parseLockOwner(raw);
    let stale = owner ? !processIsAlive(owner.pid) : false;
    if (!owner) {
        try {
            const metadata = await stat(lockPath);
            stale = Date.now() - metadata.mtimeMs >= RUNS_LOCK_STALE_MS;
        }
        catch (error) {
            if (isNodeError(error) && error.code === "ENOENT")
                return;
            throw error;
        }
    }
    if (!stale)
        return;
    // Re-read before unlinking so a contender cannot delete a newly acquired lock
    // after another process already removed the stale owner.
    try {
        if (await readFile(lockPath, "utf8") === raw)
            await unlink(lockPath);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT")
            throw error;
    }
}
function parseLockOwner(value) {
    try {
        const parsed = JSON.parse(value);
        if (isRecord(parsed)
            && typeof parsed.token === "string"
            && typeof parsed.pid === "number"
            && typeof parsed.createdAt === "number") {
            return parsed;
        }
    }
    catch {
        // A competing process may have created the file but not written its owner yet.
    }
    return undefined;
}
function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return isNodeError(error) && error.code === "EPERM";
    }
}
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function readRuns(runsPath) {
    try {
        const parsed = JSON.parse(await readFile(runsPath, "utf8"));
        if (!isRecord(parsed) || !Array.isArray(parsed.runs))
            return emptyRuns();
        return {
            version: RUNS_VERSION,
            runs: parsed.runs.filter(isStoredRun),
        };
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return emptyRuns();
        if (error instanceof SyntaxError)
            return emptyRuns();
        throw error;
    }
}
function emptyRuns() {
    return { version: RUNS_VERSION, runs: [] };
}
function isStoredRun(value) {
    return isRecord(value)
        && typeof value.run_id === "string"
        && typeof value.status === "string";
}
function trimRuns(runs) {
    if (runs.length <= MAX_RUN_RECORDS)
        return runs;
    const running = runs.filter((record) => record.status === "running");
    const terminal = runs
        .filter((record) => record.status !== "running")
        .sort((left, right) => runTimestamp(right).localeCompare(runTimestamp(left)));
    return [...running, ...terminal].slice(0, MAX_RUN_RECORDS);
}
function runTimestamp(record) {
    return typeof record.ended_at === "string"
        ? record.ended_at
        : typeof record.started_at === "string"
            ? record.started_at
            : "";
}
async function readConfiguredHome(configPath) {
    try {
        const parsed = JSON.parse(await readFile(configPath, "utf8"));
        return isRecord(parsed) && typeof parsed.home_path === "string"
            ? nonEmpty(parsed.home_path)
            : undefined;
    }
    catch (error) {
        if ((isNodeError(error) && error.code === "ENOENT") || error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
}
function expandHome(value, environment) {
    if (value === "~")
        return userHome(environment);
    if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
        return path.join(userHome(environment), value.slice(2));
    }
    return value;
}
function userHome(environment) {
    return environment.HOME || environment.USERPROFILE || os.homedir();
}
function nonEmpty(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(value) {
    return value instanceof Error && "code" in value;
}
