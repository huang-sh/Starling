import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync, mkdtempSync, chmodSync } from "fs";
import { dirname, join } from "path";

export function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function atomicWriteJSON(filePath: string, data: unknown): void {
  ensureDir(filePath);
  // Create temp file in same directory to avoid cross-device rename issues
  const dir = dirname(filePath);
  const tmpDir = join(dir, ".starling-tmp");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const prefix = join(tmpDir, "starling-");
  const wrapperDir = mkdtempSync(prefix);
  const tmpPath = join(wrapperDir, "tmp.json");
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, filePath);
  } finally {
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }
    // mkdtempSync created an empty wrapper directory; remove it whether or not
    // the rename succeeded. Best-effort — ignore errors if another concurrent
    // writer is touching the same wrapper.
    try {
      rmdirSync(wrapperDir);
    } catch {
      // leave it for a later write to clean up; not worth failing the operation
    }
  }
}

export function readJSON<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}
