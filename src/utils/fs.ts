import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdtempSync, chmodSync } from "fs";
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
  const tmpPath = mkdtempSync(prefix) + "/tmp.json";
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, filePath);
  } finally {
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }
  }
}

export function readJSON<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}
