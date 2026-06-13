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
