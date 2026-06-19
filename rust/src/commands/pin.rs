//! `starling pin` — pin a session with metadata.

use anyhow::Result;
use colored::*;

use crate::core::catalog_resolver::resolve_catalog_reference;
use crate::core::discovery::find_sessions;
use crate::core::format::format_bookmark_detail;
use crate::core::id::generate_bookmark_id;
use crate::core::session_display::short_session_id;
use crate::core::store::{add_bookmark, BookmarkFilter};
use crate::core::store::{find_bookmark, list_bookmarks, update_bookmark, BookmarkPatch};
use crate::types::{Bookmark, SessionMeta};
use crate::commands::session::resolve_session_meta;

pub fn run(session_id: Option<String>, title: Option<String>, tags: Option<String>, to: Option<String>, current: bool) -> Result<()> {
    if session_id.is_none() && !current {
        eprintln!("{}: pass a session id, or use --current for the most recent", "usage".yellow());
        return Ok(());
    }
    let mut target_id = session_id;
    if current && target_id.is_none() {
        let sessions: Vec<SessionMeta> = find_sessions(1, None);
        if sessions.is_empty() {
            eprintln!("{}: no sessions found", "error".red());
            std::process::exit(1);
        }
        target_id = Some(sessions[0].session_id.clone());
    }
    let target_id = target_id.unwrap();

    let meta = match resolve_session_meta(&target_id) {
        Some(m) => m,
        None => {
            eprintln!("{}: session not found: {}", "error".red(), target_id);
            std::process::exit(1);
        }
    };

    // Ensure bookmark
    let bookmark = if let Some(b) = find_bookmark(&meta.session_id) {
        let mut patch = BookmarkPatch::default();
        let mut changed = false;
        if let Some(t) = title.as_deref() { patch.title = Some(t.to_string()); changed = true; }
        if let Some(t) = tags.as_deref() {
            patch.tags = Some(t.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect());
            changed = true;
        }
        if changed {
            update_bookmark(&b.id, patch).unwrap_or(b)
        } else {
            b
        }
    } else {
        let store = crate::core::store::load_store();
        let bookmark = Bookmark {
            id: generate_bookmark_id(&store.bookmarks),
            provider: meta.provider.clone(),
            session_id: meta.session_id.clone(),
            title: title.clone().unwrap_or_else(|| meta.first_prompt.clone()),
            category: String::new(),
            tags: tags.as_ref()
                .map(|s| s.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect())
                .unwrap_or_default(),
            project_path: meta.project_path.clone(),
            first_prompt: meta.first_prompt.clone(),
            notes: vec![],
            space_ids: vec![],
            created_at: crate::constants::now_iso(),
            updated_at: crate::constants::now_iso(),
        };
        add_bookmark(bookmark)
    };

    // Optionally assign to a catalog
    if let Some(c) = to.as_deref() {
        match resolve_catalog_reference(c) {
            crate::core::catalog_resolver::CatalogResolution::Found(s) => {
                let mut ids = bookmark.space_ids.clone();
                if !ids.contains(&s.id) {
                    ids.push(s.id.clone());
                    update_bookmark(&bookmark.id, BookmarkPatch { space_ids: Some(ids), ..Default::default() });
                    println!("{}", format!("Added to catalog: {} ({})", s.name, s.id).green());
                }
            }
            other => {
                eprintln!("{}: could not resolve catalog '{}': {:?}", "error".red(), c, other);
                std::process::exit(2);
            }
        }
    }

    let updated = find_bookmark(&meta.session_id).unwrap_or(bookmark);
    println!("{}", format_bookmark_detail(&updated));
    println!("\n{}: pinned session {}", "ok".green().bold(), short_session_id(&meta.session_id));
    Ok(())
}

// Silence unused
#[allow(dead_code)]
fn _anchor_filters() -> Vec<Bookmark> {
    list_bookmarks(BookmarkFilter::default())
}
