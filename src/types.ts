export interface Note {
  id: string;
  content: string;
  created_at: string;
}

export interface Bookmark {
  id: string;
  provider: string;
  session_id: string;
  title: string;
  category: string;
  tags: string[];
  project_path: string;
  first_prompt: string;
  notes: Note[];
  space_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface Space {
  id: string;
  name: string;
  description: string;
  tags: string[];
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Store {
  version: number;
  bookmarks: Bookmark[];
  spaces: Space[];
  categories: string[];
}

export interface SessionMeta {
  session_id: string;
  provider: string;
  model: string;
  project_path: string;
  first_prompt: string;
  custom_title?: string;
  file_path: string;
  created_at: string;
  modified_at: string;
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_tokens?: number;
  };
}

export type RunStatus = "running" | "completed" | "errored" | "crashed" | "stale" | "unknown";
export type RunSource = "starling-run" | "detected";

export interface RunRecord {
  run_id: string;
  session_id?: string;
  provider: "claude" | "codex";
  project_path?: string;
  catalog_id?: string;
  pid?: number;
  status: RunStatus;
  exit_code?: number;
  started_at: string;
  ended_at?: string;
  source: RunSource;
}

export interface RunsFile {
  version: number;
  runs: RunRecord[];
}
