//! Store CRUD — mirrors src/lib/store.ts.
//!
//! The store is a JSON file at `STARLING_CONFIG` or `~/.config/starling/store.json`
//! (or `<STARLING_HOME>/store.json` when the home override is in effect). We
//! load → mutate → atomic-write on every operation to keep semantics
//! compatible with the TS implementation.

use std::path::PathBuf;

use crate::constants::{default_store_path, env_or, now_iso, ENV_CONFIG_KEY};
use crate::core::fs_utils::{atomic_write_json, read_json};
use crate::core::id::generate_space_id;
use crate::types::{Bookmark, Note, Space, Store};

/// Path to the active store.json.
pub fn store_path() -> PathBuf {
    env_or(ENV_CONFIG_KEY, default_store_path())
}

fn default_spaces() -> Vec<Space> {
    let now1 = now_iso();
    let now2 = now_iso();
    vec![
        Space {
            id: "cat_0001".into(),
            name: "claude".into(),
            description: "Claude Code sessions".into(),
            tags: vec![],
            parent_id: None,
            created_at: now1.clone(),
            updated_at: now1,
        },
        Space {
            id: "cat_0002".into(),
            name: "codex".into(),
            description: "Codex sessions".into(),
            tags: vec![],
            parent_id: None,
            created_at: now2.clone(),
            updated_at: now2,
        },
    ]
}

fn fresh_store() -> Store {
    Store {
        version: crate::constants::STORE_VERSION,
        bookmarks: vec![],
        spaces: default_spaces(),
        categories: vec![],
    }
}

/// Load the store, applying migrations and ensuring default spaces exist.
/// Writes back if any migration was applied.
pub fn load_store() -> Store {
    let path = store_path();
    let loaded: Option<Store> = read_json(&path);
    let mut store = match loaded {
        Some(s) => s,
        None => return fresh_store(),
    };

    let mut migrated = false;

    // --- Migration: space_XXXX → cat_XXXX ---
    let mut legacy_map: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let used_cat_ids: std::collections::HashSet<String> = store
        .spaces
        .iter()
        .filter(|s| s.id.starts_with("cat_"))
        .map(|s| s.id.clone())
        .collect();
    let mut next_id: u32 = 1;
    let next_catalog_id = |used: &std::collections::HashSet<String>, next: &mut u32| -> String {
        loop {
            let cand = format!("cat_{:04}", *next);
            *next += 1;
            if !used.contains(&cand) {
                return cand;
            }
        }
    };

    for space in store.spaces.iter_mut() {
        if space.id.starts_with("space_") {
            let mut used = used_cat_ids.clone();
            for (old, new) in legacy_map.iter() {
                used.insert(new.clone());
                let _ = old; // unused
            }
            let new_id = next_catalog_id(&used, &mut next_id);
            legacy_map.insert(space.id.clone(), new_id.clone());
            space.id = new_id;
            migrated = true;
        }
    }

    if migrated && !legacy_map.is_empty() {
        for b in store.bookmarks.iter_mut() {
            b.space_ids = b
                .space_ids
                .iter()
                .map(|sid| legacy_map.get(sid).cloned().unwrap_or_else(|| sid.clone()))
                .collect();
        }
        for s in store.spaces.iter_mut() {
            if let Some(pid) = &s.parent_id {
                if let Some(new_pid) = legacy_map.get(pid) {
                    s.parent_id = Some(new_pid.clone());
                }
            }
        }
    }

    // --- Ensure default spaces exist ---
    if !store.spaces.iter().any(|s| s.name == "claude") {
        let now = now_iso();
        let id = generate_space_id(&store.spaces);
        store.spaces.push(Space {
            id,
            name: "claude".into(),
            description: "Claude Code sessions".into(),
            tags: vec![],
            parent_id: None,
            created_at: now.clone(),
            updated_at: now,
        });
        migrated = true;
    }
    if !store.spaces.iter().any(|s| s.name == "codex") {
        let now = now_iso();
        let id = generate_space_id(&store.spaces);
        store.spaces.push(Space {
            id,
            name: "codex".into(),
            description: "Codex sessions".into(),
            tags: vec![],
            parent_id: None,
            created_at: now.clone(),
            updated_at: now,
        });
        migrated = true;
    }

    if migrated {
        let _ = save_store(&store);
    }
    store
}

pub fn save_store(store: &Store) -> std::io::Result<()> {
    atomic_write_json(&store_path(), store)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
}

// --- Bookmark CRUD ---

pub fn add_bookmark(bookmark: Bookmark) -> Bookmark {
    let mut store = load_store();
    if !bookmark.category.is_empty() && !store.categories.contains(&bookmark.category) {
        store.categories.push(bookmark.category.clone());
    }
    store.bookmarks.push(bookmark.clone());
    let _ = save_store(&store);
    bookmark
}

/// Find by Starling bookmark ID or by session ID.
pub fn find_bookmark(id: &str) -> Option<Bookmark> {
    load_store()
        .bookmarks
        .into_iter()
        .find(|b| b.id == id || b.session_id == id)
}

pub fn update_bookmark(id: &str, patch: BookmarkPatch) -> Option<Bookmark> {
    let mut store = load_store();
    let idx = store
        .bookmarks
        .iter()
        .position(|b| b.id == id || b.session_id == id)?;
    let updated = apply_patch(&store.bookmarks[idx], patch);
    if !updated.category.is_empty() && !store.categories.contains(&updated.category) {
        store.categories.push(updated.category.clone());
    }
    store.bookmarks[idx] = updated.clone();
    let _ = save_store(&store);
    Some(updated)
}

/// Subset of `Bookmark` whose fields may be updated. `None` means "leave
/// unchanged".
#[derive(Default, Clone)]
pub struct BookmarkPatch {
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub project_path: Option<String>,
    pub first_prompt: Option<String>,
    pub notes: Option<Vec<Note>>,
    pub space_ids: Option<Vec<String>>,
    pub custom_title: Option<Option<String>>,
}

fn apply_patch(source: &Bookmark, patch: BookmarkPatch) -> Bookmark {
    Bookmark {
        id: source.id.clone(),
        provider: source.provider.clone(),
        session_id: patch
            .session_id
            .unwrap_or_else(|| source.session_id.clone()),
        title: patch.title.unwrap_or_else(|| source.title.clone()),
        category: patch.category.unwrap_or_else(|| source.category.clone()),
        tags: patch.tags.unwrap_or_else(|| source.tags.clone()),
        project_path: patch
            .project_path
            .unwrap_or_else(|| source.project_path.clone()),
        first_prompt: patch
            .first_prompt
            .unwrap_or_else(|| source.first_prompt.clone()),
        notes: patch.notes.unwrap_or_else(|| source.notes.clone()),
        space_ids: patch.space_ids.unwrap_or_else(|| source.space_ids.clone()),
        created_at: source.created_at.clone(),
        updated_at: now_iso(),
    }
}

pub fn remove_bookmark(id: &str) -> bool {
    let mut store = load_store();
    let before = store.bookmarks.len();
    store.bookmarks.retain(|b| b.id != id && b.session_id != id);
    if store.bookmarks.len() == before {
        return false;
    }
    let _ = save_store(&store);
    true
}

pub fn list_bookmarks(filter: BookmarkFilter) -> Vec<Bookmark> {
    let store = load_store();
    store
        .bookmarks
        .into_iter()
        .filter(|b| {
            filter
                .category
                .as_ref()
                .map(|c| &b.category == c)
                .unwrap_or(true)
        })
        .filter(|b| {
            filter
                .tag
                .as_ref()
                .map(|t| b.tags.contains(t))
                .unwrap_or(true)
        })
        .collect()
}

#[derive(Default, Clone)]
pub struct BookmarkFilter {
    pub category: Option<String>,
    pub tag: Option<String>,
}

pub fn search_bookmarks(query: &str) -> Vec<Bookmark> {
    let q = query.to_lowercase();
    load_store()
        .bookmarks
        .into_iter()
        .filter(|b| {
            b.title.to_lowercase().contains(&q)
                || b.category.to_lowercase().contains(&q)
                || b.tags.iter().any(|t| t.to_lowercase().contains(&q))
                || b.first_prompt.to_lowercase().contains(&q)
                || b.notes
                    .iter()
                    .any(|n| n.content.to_lowercase().contains(&q))
        })
        .collect()
}

// --- Space CRUD ---

pub fn add_space(space: Space) -> Space {
    let mut store = load_store();
    store.spaces.push(space.clone());
    let _ = save_store(&store);
    space
}

/// Resolve by ID or unique name/path. Returns None when ambiguous.
pub fn find_space(id_or_name: &str) -> Option<Space> {
    let matches = find_space_candidates(id_or_name);
    if matches.len() == 1 {
        Some(matches.into_iter().next().unwrap())
    } else {
        None
    }
}

/// All spaces matching the given reference (exact ID first, then name, then
/// slash-separated path).
pub fn find_space_candidates(id_name_or_path: &str) -> Vec<Space> {
    let store = load_store();
    if let Some(exact) = store
        .spaces
        .iter()
        .find(|s| s.id == id_name_or_path)
        .cloned()
    {
        return vec![exact];
    }
    if id_name_or_path.contains('/') {
        return find_space_path_candidates(id_name_or_path, &store.spaces);
    }
    store
        .spaces
        .into_iter()
        .filter(|s| s.name == id_name_or_path)
        .collect()
}

fn find_space_path_candidates(path_ref: &str, spaces: &[Space]) -> Vec<Space> {
    let parts: Vec<&str> = path_ref
        .split('/')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return vec![];
    }

    let mut candidates: Vec<Space> = spaces
        .iter()
        .filter(|s| s.name == parts[0] && s.parent_id.is_none())
        .cloned()
        .collect();
    for part in parts.iter().skip(1) {
        let parent_ids: std::collections::HashSet<String> =
            candidates.iter().map(|s| s.id.clone()).collect();
        candidates = spaces
            .iter()
            .filter(|s| {
                s.name == *part
                    && s.parent_id.is_some()
                    && s.parent_id
                        .as_ref()
                        .map(|p| parent_ids.contains(p))
                        .unwrap_or(false)
            })
            .cloned()
            .collect();
        if candidates.is_empty() {
            return vec![];
        }
    }
    candidates
}

pub fn has_sibling_space_name(
    name: &str,
    parent_id: Option<&str>,
    exclude_id: Option<&str>,
) -> bool {
    load_store().spaces.iter().any(|s| {
        s.name == name && s.parent_id.as_deref() == parent_id && Some(s.id.as_str()) != exclude_id
    })
}

pub fn update_space(id: &str, patch: SpacePatch) -> Option<Space> {
    let mut store = load_store();
    let idx = store
        .spaces
        .iter()
        .position(|s| s.id == id || s.name == id)?;
    let updated = apply_space_patch(&store.spaces[idx], patch);
    store.spaces[idx] = updated.clone();
    let _ = save_store(&store);
    Some(updated)
}

#[derive(Default, Clone)]
pub struct SpacePatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    pub parent_id: Option<Option<String>>,
}

fn apply_space_patch(source: &Space, patch: SpacePatch) -> Space {
    Space {
        id: source.id.clone(),
        name: patch.name.unwrap_or_else(|| source.name.clone()),
        description: patch
            .description
            .unwrap_or_else(|| source.description.clone()),
        tags: patch.tags.unwrap_or_else(|| source.tags.clone()),
        parent_id: patch.parent_id.unwrap_or_else(|| source.parent_id.clone()),
        created_at: source.created_at.clone(),
        updated_at: now_iso(),
    }
}

pub fn remove_space(id: &str) -> bool {
    let mut store = load_store();
    let idx = match store.spaces.iter().position(|s| s.id == id || s.name == id) {
        Some(i) => i,
        None => return false,
    };
    let space_id = store.spaces[idx].id.clone();

    // Collect the subtree
    let mut ids_to_remove: std::collections::HashSet<String> = std::collections::HashSet::new();
    ids_to_remove.insert(space_id);
    loop {
        let mut changed = false;
        for candidate in store.spaces.iter() {
            if let Some(pid) = &candidate.parent_id {
                if ids_to_remove.contains(pid) && !ids_to_remove.contains(&candidate.id) {
                    ids_to_remove.insert(candidate.id.clone());
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }

    for b in store.bookmarks.iter_mut() {
        b.space_ids.retain(|sid| !ids_to_remove.contains(sid));
    }
    store.spaces.retain(|s| !ids_to_remove.contains(&s.id));
    let _ = save_store(&store);
    true
}

pub fn list_spaces() -> Vec<Space> {
    load_store().spaces
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::fs_utils::test_support::with_temp_store;

    #[test]
    fn fresh_store_has_default_spaces() {
        with_temp_store(|| {
            let s = load_store();
            assert!(s.spaces.iter().any(|sp| sp.name == "claude"));
            assert!(s.spaces.iter().any(|sp| sp.name == "codex"));
            assert_eq!(s.version, 1);
        });
    }

    #[test]
    fn add_and_find_bookmark() {
        with_temp_store(|| {
            let b = Bookmark {
                id: "starling_0001".into(),
                provider: "claude".into(),
                session_id: "sess-abc".into(),
                title: "Hello".into(),
                category: "demo".into(),
                tags: vec!["x".into()],
                project_path: "/p".into(),
                first_prompt: "hi".into(),
                notes: vec![],
                space_ids: vec!["cat_0001".into()],
                created_at: now_iso(),
                updated_at: now_iso(),
            };
            add_bookmark(b);
            assert!(find_bookmark("sess-abc").is_some());
            assert!(find_bookmark("starling_0001").is_some());
            // Categories auto-tracked
            let s = load_store();
            assert!(s.categories.contains(&"demo".to_string()));
        });
    }

    #[test]
    fn update_and_remove_bookmark() {
        with_temp_store(|| {
            let b = Bookmark {
                id: "starling_0001".into(),
                provider: "claude".into(),
                session_id: "sess-xyz".into(),
                title: "Old".into(),
                category: "a".into(),
                tags: vec![],
                project_path: "/p".into(),
                first_prompt: "".into(),
                notes: vec![],
                space_ids: vec![],
                created_at: now_iso(),
                updated_at: now_iso(),
            };
            add_bookmark(b);
            let patch = BookmarkPatch {
                title: Some("New".into()),
                ..Default::default()
            };
            let updated = update_bookmark("sess-xyz", patch).expect("exists");
            assert_eq!(updated.title, "New");
            assert!(remove_bookmark("sess-xyz"));
            assert!(find_bookmark("sess-xyz").is_none());
        });
    }

    #[test]
    fn space_subtree_removal_unlinks_bookmarks() {
        with_temp_store(|| {
            let parent = Space {
                id: "cat_0099".into(),
                name: "parent".into(),
                description: "".into(),
                tags: vec![],
                parent_id: None,
                created_at: now_iso(),
                updated_at: now_iso(),
            };
            add_space(parent);
            let child = Space {
                id: "cat_0100".into(),
                name: "child".into(),
                description: "".into(),
                tags: vec![],
                parent_id: Some("cat_0099".into()),
                created_at: now_iso(),
                updated_at: now_iso(),
            };
            add_space(child);
            let b = Bookmark {
                id: "starling_0001".into(),
                provider: "claude".into(),
                session_id: "s1".into(),
                title: "T".into(),
                category: "c".into(),
                tags: vec![],
                project_path: "/p".into(),
                first_prompt: "".into(),
                notes: vec![],
                space_ids: vec!["cat_0099".into(), "cat_0100".into()],
                created_at: now_iso(),
                updated_at: now_iso(),
            };
            add_bookmark(b);
            assert!(remove_space("cat_0099"));
            let b = find_bookmark("s1").unwrap();
            assert!(
                b.space_ids.is_empty(),
                "space_ids should be cleared: {:?}",
                b.space_ids
            );
            assert!(find_space("cat_0099").is_none());
            assert!(find_space("cat_0100").is_none());
        });
    }

    #[test]
    fn find_space_path_resolution() {
        with_temp_store(|| {
            let root = Space {
                id: "cat_0101".into(),
                name: "root".into(),
                description: "".into(),
                tags: vec![],
                parent_id: None,
                created_at: now_iso(),
                updated_at: now_iso(),
            };
            add_space(root);
            let child = Space {
                id: "cat_0102".into(),
                name: "leaf".into(),
                description: "".into(),
                tags: vec![],
                parent_id: Some("cat_0101".into()),
                created_at: now_iso(),
                updated_at: now_iso(),
            };
            add_space(child);
            let found = find_space("root/leaf");
            assert!(found.is_some(), "path resolution should find the leaf");
            assert_eq!(found.unwrap().id, "cat_0102");
        });
    }
}
