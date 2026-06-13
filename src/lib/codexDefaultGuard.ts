import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { DEFAULT_CODEX_HOME } from "../constants.js";
import { ensureDir } from "../utils/fs.js";

interface FileSnapshot {
  path: string;
  existed: boolean;
  content?: string;
  mode?: number;
}

export interface CodexDefaultConfigSnapshot {
  files: FileSnapshot[];
}

export function snapshotCodexDefaultConfig(): CodexDefaultConfigSnapshot {
  return {
    files: [
      snapshotFile(join(DEFAULT_CODEX_HOME, "config.toml")),
      snapshotFile(join(DEFAULT_CODEX_HOME, "auth.json")),
    ],
  };
}

export function restoreCodexDefaultConfig(snapshot: CodexDefaultConfigSnapshot | null): void {
  if (!snapshot) return;
  for (const file of snapshot.files) {
    restoreFile(file);
  }
}

function snapshotFile(path: string): FileSnapshot {
  if (!existsSync(path)) {
    return { path, existed: false };
  }
  const st = statSync(path);
  return {
    path,
    existed: true,
    content: readFileSync(path, "utf-8"),
    mode: st.mode & 0o777,
  };
}

function restoreFile(snapshot: FileSnapshot): void {
  if (!snapshot.existed) {
    if (existsSync(snapshot.path)) {
      unlinkSync(snapshot.path);
    }
    return;
  }

  ensureDir(snapshot.path);
  writeFileSync(snapshot.path, snapshot.content ?? "", "utf-8");
  if (snapshot.mode !== undefined) {
    chmodSync(snapshot.path, snapshot.mode);
  }
}
