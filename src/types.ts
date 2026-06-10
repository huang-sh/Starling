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
  nest_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface Nest {
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
  nests: Nest[];
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
}
