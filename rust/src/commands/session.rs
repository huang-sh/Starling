//! Session subcommands.

use std::collections::HashMap;

use anyhow::Result;
use colored::*;

use crate::cli::*;
use crate::core::catalog_resolver::{catalog_path, resolve_catalog_reference};
use crate::core::discovery::{find_session_by_id, find_session_candidates, find_sessions, Provider};
use crate::core::format::format_session_table;
use crate::core::id::{generate_bookmark_id, generate_note_id};
use crate::core::runs::{get_run_status_for_session, reconcile_stale_runs, status_badge, RunStatus};
use crate::core::session_index::{
    clear_session_index, is_session_index_stale, load_session_index, lookup_indexed_sessions,
    rebuild_session_index, remove_session_from_index, session_index_path,
};
use crate::core::store::{find_bookmark, list_bookmarks, list_spaces, remove_bookmark, update_bookmark, BookmarkPatch};
use crate::core::session_display::short_session_id;
use crate::constants::now_iso;
use crate::types::{Bookmark, SessionMeta};

pub fn handle(cmd: SessionCommand) -> Result<()> {
    match cmd {
        SessionCommand::List { limit, agent, cataloged, catalog, all, json } => list_cmd(limit, agent, cataloged, catalog, all, json),
        SessionCommand::Show { session_id, json } => show_cmd(&session_id, json),
        SessionCommand::Lookup { session_ids, agent, json } => lookup_cmd(session_ids, agent, json),
        SessionCommand::Resume { session_id } => super::resume::run(&session_id),
        SessionCommand::Meta { session_id, title, tags, add_tags, json } => meta_cmd(&session_id, title, tags, add_tags, json),
        SessionCommand::Note { session_id, content, json } => note_cmd(&session_id, &content.join(" "), json),
        SessionCommand::Unpin { session_id, json } => unpin_cmd(&session_id, json),
        SessionCommand::Delete { session_id, yes, json } => delete_cmd(&session_id, yes, json),
        SessionCommand::Index(sub) => handle_index(sub),
        SessionCommand::Catalog(sub) => handle_session_catalog(sub),
    }
}

fn provider_from_opt(s: Option<&str>) -> Option<Provider> {
    match s {
        Some("claude") => Some(Provider::Claude),
        Some("codex") => Some(Provider::Codex),
        Some(other) => {
            eprintln!("{}: unknown agent '{}' (expected claude or codex)", "error".red(), other);
            std::process::exit(2);
        }
        None => None,
    }
}

fn provider_to_idx(p: Option<Provider>) -> Option<crate::core::session_index::Provider> {
    p.map(|p| match p {
        Provider::Claude => crate::core::session_index::Provider::Claude,
        Provider::Codex => crate::core::session_index::Provider::Codex,
    })
}

fn build_status_map(sessions: &[SessionMeta]) -> HashMap<String, RunStatus> {
    sessions.iter().map(|s| (s.session_id.clone(), get_run_status_for_session(&s.session_id))).collect()
}

fn list_cmd(limit: usize, agent: Option<String>, cataloged: bool, catalog: Option<String>, all: bool, json: bool) -> Result<()> {
    let provider = provider_from_opt(agent.as_deref());
    let has_catalog_filter = cataloged || catalog.is_some();
    reconcile_stale_runs();

    if all {
        let mut filtered = if has_catalog_filter {
            find_catalog_sessions(cataloged, catalog.as_deref(), provider)
        } else {
            find_sessions(usize::MAX, provider)
        };
        // For --all we stream-style print but skip the pager for simplicity
        if json {
            println!("{}", serde_json::to_string_pretty(&filtered)?);
            return Ok(());
        }
        let status_map = build_status_map(&filtered);
        print!("{}", format_session_table(&filtered, Some(&status_map)));
        println!("\n{}", format!("Total: {} sessions", filtered.len()).normal());
        let _ = filtered.drain(..);
        return Ok(());
    }

    let catalog_sessions = if has_catalog_filter {
        Some(find_catalog_sessions(cataloged, catalog.as_deref(), provider))
    } else { None };

    let sessions = if let Some(cs) = catalog_sessions.as_ref() {
        cs.iter().take(limit).cloned().collect::<Vec<_>>()
    } else {
        find_sessions(limit, provider)
    };

    if sessions.is_empty() {
        println!("{}", "No sessions found.".yellow());
        return Ok(());
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&sessions)?);
        return Ok(());
    }

    let status_map = build_status_map(&sessions);
    println!("{}", format_session_table(&sessions, Some(&status_map)));
    Ok(())
}

fn find_catalog_sessions(cataloged: bool, catalog_filter: Option<&str>, provider: Option<Provider>) -> Vec<SessionMeta> {
    let bookmarks: Vec<Bookmark> = list_bookmarks(crate::core::store::BookmarkFilter::default());
    let mut target_space_ids: Option<Vec<String>> = None;
    if let Some(c) = catalog_filter {
        match resolve_catalog_reference(c) {
            crate::core::catalog_resolver::CatalogResolution::Found(s) => target_space_ids = Some(vec![s.id]),
            crate::core::catalog_resolver::CatalogResolution::Ambiguous(matches) => {
                eprintln!("{}: ambiguous catalog '{}': {}", "error".red(), c,
                    matches.iter().map(|s| s.name.clone()).collect::<Vec<_>>().join(", "));
                std::process::exit(2);
            }
            crate::core::catalog_resolver::CatalogResolution::NotFound => {
                eprintln!("{}: catalog not found: {}", "error".red(), c);
                std::process::exit(2);
            }
        }
    }
    let _ = cataloged; // Same as filtering to non-empty space_ids

    let wanted_session_ids: Vec<String> = bookmarks.iter()
        .filter(|b| !b.space_ids.is_empty())
        .filter(|b| target_space_ids.as_ref().map(|ids| ids.iter().any(|id| b.space_ids.contains(id))).unwrap_or(true))
        .map(|b| b.session_id.clone())
        .collect();

    let looked_up = lookup_indexed_sessions(&wanted_session_ids, provider_to_idx(provider));
    let mut sessions: Vec<SessionMeta> = looked_up.values().cloned().collect();
    sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    sessions
}

fn show_cmd(session_id: &str, json: bool) -> Result<()> {
    let meta = match find_session_by_id(session_id) {
        Some(m) => m,
        None => {
            eprintln!("{}: session not found: {}", "error".red(), session_id);
            std::process::exit(1);
        }
    };
    let bookmark = find_bookmark(&meta.session_id);
    let spaces = list_spaces();
    let catalogs: Vec<String> = bookmark.as_ref()
        .map(|b| {
            b.space_ids.iter()
                .filter_map(|sid| spaces.iter().find(|s| &s.id == sid))
                .map(|s| format!("{} ({})", s.name, s.id))
                .collect()
        })
        .unwrap_or_default();

    if json {
        #[derive(serde::Serialize)]
        struct Show<'a> {
            #[serde(flatten)] meta: &'a SessionMeta,
            catalogs: Vec<String>,
            bookmark: Option<&'a Bookmark>,
        }
        let payload = Show { meta: &meta, catalogs, bookmark: bookmark.as_ref() };
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }

    println!("{}", format!("Session: {}", meta.session_id).cyan().bold());
    println!("  Provider:    {}", meta.provider);
    println!("  Model:       {}", if meta.model.is_empty() { "-" } else { &meta.model });
    println!("  Project:     {}", if meta.project_path.is_empty() { "-" } else { &meta.project_path });
    println!("  File:        {}", meta.file_path);
    println!("  Modified:    {}", meta.modified_at);
    println!("  Catalogs:    {}", if catalogs.is_empty() { "-".to_string() } else { catalogs.join(", ") });
    if let Some(b) = &bookmark {
        println!("  Title:       {}", if b.title.is_empty() { "-" } else { &b.title });
        println!("  Tags:        {}", if b.tags.is_empty() { "-".to_string() } else { b.tags.join(", ") });
        if !b.notes.is_empty() {
            println!("  Notes:");
            for note in &b.notes {
                println!("    {}: {}", note.id, note.content);
            }
        }
    }
    if let Some(tokens) = &meta.token_usage {
        println!("  Token Usage:");
        println!("    Input:   {}", tokens.input_tokens.map(|n| n.to_string()).unwrap_or_else(|| "-".into()));
        println!("    Output:  {}", tokens.output_tokens.map(|n| n.to_string()).unwrap_or_else(|| "-".into()));
        println!("    Total:   {}", tokens.total_tokens.map(|n| n.to_string()).unwrap_or_else(|| "-".into()));
        println!("    Cache:   {}", tokens.cache_tokens.map(|n| n.to_string()).unwrap_or_else(|| "-".into()));
    }
    if !meta.first_prompt.is_empty() {
        println!("  First Prompt:");
        println!("    {}", meta.first_prompt);
    }
    Ok(())
}

fn lookup_cmd(session_ids: Vec<String>, agent: Option<String>, json: bool) -> Result<()> {
    let provider = provider_from_opt(agent.as_deref());
    let found = lookup_indexed_sessions(&session_ids, provider_to_idx(provider));
    let mut sessions: Vec<SessionMeta> = found.values().cloned().collect();
    sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    let requested = session_ids.len();
    let resolved = sessions.len();
    if json {
        println!("{}", serde_json::to_string_pretty(&sessions)?);
        if resolved < requested {
            eprintln!("{}", format!("Resolved {}/{} sessions.", resolved, requested).normal());
        }
        return Ok(());
    }
    if sessions.is_empty() {
        println!("{}", format!("No sessions found for {} id(s).", requested).yellow());
        return Ok(());
    }
    println!("{}", format_session_table(&sessions, None));
    if resolved < requested {
        println!("{}", format!("Resolved {}/{} sessions.", resolved, requested).normal());
    }
    Ok(())
}

pub fn resolve_session_meta(session_id: &str) -> Option<SessionMeta> {
    if let Some(meta) = find_session_by_id(session_id) { return Some(meta); }
    let candidates = find_session_candidates(session_id);
    candidates.into_iter().next()
}

fn ensure_session_bookmark(meta: &SessionMeta, title: Option<&str>, tags: Option<Vec<String>>) -> Bookmark {
    if let Some(existing) = find_bookmark(&meta.session_id) { return existing; }
    let store = crate::core::store::load_store();
    let id = generate_bookmark_id(&store.bookmarks);
    let bookmark = Bookmark {
        id,
        provider: meta.provider.clone(),
        session_id: meta.session_id.clone(),
        title: title.map(String::from).unwrap_or_else(|| meta.first_prompt.clone()),
        category: String::new(),
        tags: tags.unwrap_or_default(),
        project_path: meta.project_path.clone(),
        first_prompt: meta.first_prompt.clone(),
        notes: vec![],
        space_ids: vec![],
        created_at: now_iso(),
        updated_at: now_iso(),
    };
    crate::core::store::add_bookmark(bookmark.clone());
    bookmark
}

fn parse_tags(s: &str) -> Vec<String> {
    s.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()
}

fn meta_cmd(session_id: &str, title: Option<String>, tags: Option<String>, add_tags: Option<String>, json: bool) -> Result<()> {
    let meta = match resolve_session_meta(session_id) {
        Some(m) => m,
        None => {
            eprintln!("{}: session not found: {}", "error".red(), session_id);
            std::process::exit(1);
        }
    };
    let bookmark = ensure_session_bookmark(&meta, None, None);
    let mut patch = BookmarkPatch::default();
    if let Some(t) = title { patch.title = Some(t); }
    if let Some(t) = tags { patch.tags = Some(parse_tags(&t)); }
    if let Some(t) = add_tags {
        let mut merged: Vec<String> = bookmark.tags.clone();
        for tag in parse_tags(&t) {
            if !merged.contains(&tag) { merged.push(tag); }
        }
        patch.tags = Some(merged);
    }
    if patch.title.is_none() && patch.tags.is_none() {
        if json {
            return super::print_json_result(
                "session.meta",
                &format!("No metadata changes provided for {}.", bookmark.id),
                serde_json::json!({ "bookmark": bookmark, "changed": false }),
            );
        }
        println!("{}", format!("No metadata changes provided for {}.", bookmark.id).yellow());
        return Ok(());
    }
    let updated = update_bookmark(&bookmark.id, patch).unwrap_or(bookmark);
    if json {
        return super::print_json_result(
            "session.meta",
            &format!("Updated session metadata: {}", updated.id),
            serde_json::json!({ "bookmark": updated, "changed": true }),
        );
    }
    println!("{}", format!("Updated session metadata: {}", updated.id).green());
    Ok(())
}

fn note_cmd(session_id: &str, content: &str, json: bool) -> Result<()> {
    let content = content.trim();
    if content.is_empty() {
        eprintln!("{}: note content is required.", "error".red());
        std::process::exit(1);
    }
    let meta = match resolve_session_meta(session_id) {
        Some(m) => m,
        None => {
            eprintln!("{}: session not found: {}", "error".red(), session_id);
            std::process::exit(1);
        }
    };
    let bookmark = ensure_session_bookmark(&meta, None, None);
    let mut notes = bookmark.notes.clone();
    let note = crate::types::Note {
        id: generate_note_id(),
        content: content.to_string(),
        created_at: now_iso(),
    };
    notes.push(note.clone());
    update_bookmark(&bookmark.id, BookmarkPatch { notes: Some(notes), ..Default::default() });
    if json {
        return super::print_json_result(
            "session.note",
            &format!("Note added to {}", bookmark.id),
            serde_json::json!({ "bookmark_id": bookmark.id, "note": note }),
        );
    }
    println!("{}", format!("Note added to {}", bookmark.id).green());
    Ok(())
}

fn unpin_cmd(session_id: &str, json: bool) -> Result<()> {
    let bookmark = match find_bookmark(session_id) {
        Some(b) => b,
        None => {
            if json {
                return super::print_json_result(
                    "session.unpin",
                    &format!("Session metadata not found: {}", session_id),
                    serde_json::json!({ "session_id": session_id, "removed": false }),
                );
            }
            println!("{}", format!("Session metadata not found: {}", session_id).yellow());
            return Ok(());
        }
    };
    remove_bookmark(&bookmark.id);
    if json {
        return super::print_json_result(
            "session.unpin",
            &format!("Removed pin metadata for {}", short_session_id(&bookmark.session_id)),
            serde_json::json!({ "bookmark": bookmark, "removed": true }),
        );
    }
    println!("{}", format!("Removed pin metadata for {}", short_session_id(&bookmark.session_id)).green());
    Ok(())
}

fn delete_cmd(session_id: &str, yes: bool, json: bool) -> Result<()> {
    if !yes {
        eprintln!("{}: deleting a session file requires --yes.", "error".red());
        std::process::exit(1);
    }
    let meta = match resolve_session_meta(session_id) {
        Some(m) => m,
        None => {
            eprintln!("{}: session not found: {}", "error".red(), session_id);
            std::process::exit(1);
        }
    };
    let file_path = std::path::Path::new(&meta.file_path);
    if !file_path.exists() {
        eprintln!("{}: session file not found: {}", "error".red(), meta.file_path);
        std::process::exit(1);
    }
    if let Err(e) = std::fs::remove_file(file_path) {
        eprintln!("{}: failed to delete session file: {}", "error".red(), e);
        std::process::exit(1);
    }
    let bookmark = find_bookmark(&meta.session_id);
    if let Some(b) = &bookmark {
        remove_bookmark(&b.id);
    }
    remove_session_from_index(&meta.session_id);
    if json {
        return super::print_json_result(
            "session.delete",
            &format!("Deleted session {}", short_session_id(&meta.session_id)),
            serde_json::json!({
                "session_id": meta.session_id,
                "file_path": meta.file_path,
                "removed_pin": bookmark,
            }),
        );
    }
    println!("{}", format!("Deleted session {}", short_session_id(&meta.session_id)).green());
    println!("  File: {}", meta.file_path);
    if let Some(b) = &bookmark {
        println!("{}", format!("  Removed pin: {}", b.id).normal());
    }
    Ok(())
}

fn handle_index(sub: IndexCommand) -> Result<()> {
    match sub {
        IndexCommand::Status { json } => {
            let path = session_index_path();
            let current = load_session_index();
            if json {
                #[derive(serde::Serialize)]
                struct Out {
                    path: String,
                    exists: bool,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    built_at: Option<String>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    session_count: Option<u32>,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    project_count: Option<u32>,
                }
                let out = match &current {
                    Some(i) => Out {
                        path: path.to_string_lossy().to_string(),
                        exists: true,
                        built_at: Some(i.built_at.clone()),
                        session_count: Some(i.session_count),
                        project_count: Some(i.project_count),
                    },
                    None => Out { path: path.to_string_lossy().to_string(), exists: false, built_at: None, session_count: None, project_count: None },
                };
                println!("{}", serde_json::to_string_pretty(&out)?);
                return Ok(());
            }
            match current {
                None => {
                    println!("{}", "No session index found.".yellow());
                    println!("  Path: {}", path.display());
                }
                Some(i) => {
                    println!("{}", "Session index".green());
                    println!("  Path:     {}", path.display());
                    println!("  Built:    {}", i.built_at);
                    println!("  Sessions: {}", i.session_count);
                    println!("  Projects: {}", i.project_count);
                }
            }
            Ok(())
        }
        IndexCommand::Rebuild { agent, json } => {
            let provider = provider_from_opt(agent.as_deref());
            let rebuilt = rebuild_session_index(provider_to_idx(provider));
            if json {
                println!("{}", serde_json::to_string_pretty(&rebuilt)?);
                return Ok(());
            }
            println!("{}", "Rebuilt session index".green());
            println!("  Path:     {}", session_index_path().display());
            println!("  Sessions: {}", rebuilt.session_count);
            println!("  Projects: {}", rebuilt.project_count);
            Ok(())
        }
        IndexCommand::Clear { json } => {
            let removed = clear_session_index();
            if json {
                return super::print_json_result(
                    "session.index.clear",
                    if removed { "Session index removed." } else { "No session index found." },
                    serde_json::json!({ "removed": removed, "path": session_index_path().to_string_lossy() }),
                );
            }
            println!("{}", if removed { "Session index removed.".green() } else { "No session index found.".yellow() });
            Ok(())
        }
    }
}

fn handle_session_catalog(sub: SessionCatalogCommand) -> Result<()> {
    match sub {
        SessionCatalogCommand::Add { session_id, catalog, title, tags, json } => {
            let entry = match resolve_catalog_reference(&catalog) {
                crate::core::catalog_resolver::CatalogResolution::Found(s) => s,
                crate::core::catalog_resolver::CatalogResolution::Ambiguous(_) => {
                    eprintln!("{}: ambiguous catalog: {}", "error".red(), catalog);
                    std::process::exit(2);
                }
                crate::core::catalog_resolver::CatalogResolution::NotFound => {
                    eprintln!("{}: catalog not found: {}", "error".red(), catalog);
                    std::process::exit(2);
                }
            };
            let meta = match resolve_session_meta(&session_id) {
                Some(m) => m,
                None => {
                    eprintln!("{}: session not found: {}", "error".red(), session_id);
                    std::process::exit(1);
                }
            };
            let tags_vec = tags.as_ref().map(|s| parse_tags(s));
            let bookmark = ensure_session_bookmark(&meta, title.as_deref(), tags_vec);
            if bookmark.space_ids.contains(&entry.id) {
                if json {
                    return super::print_json_result(
                        "session.catalog.add",
                        &format!("Session already in catalog \"{}\".", entry.name),
                        serde_json::json!({ "bookmark": bookmark, "catalog": entry, "changed": false }),
                    );
                }
                println!("{}", format!("Session already in catalog \"{}\".", entry.name).yellow());
                return Ok(());
            }
            let mut ids = bookmark.space_ids.clone();
            ids.push(entry.id.clone());
            update_bookmark(&bookmark.id, BookmarkPatch { space_ids: Some(ids), ..Default::default() });
            if json {
                let updated = find_bookmark(&bookmark.session_id).unwrap_or(bookmark);
                return super::print_json_result(
                    "session.catalog.add",
                    &format!("Added session {} to catalog \"{}\"", short_session_id(&updated.session_id), entry.name),
                    serde_json::json!({ "bookmark": updated, "catalog": entry, "changed": true }),
                );
            }
            println!("{}", format!("Added session {} to catalog \"{}\"", short_session_id(&bookmark.session_id), entry.name).green());
            Ok(())
        }
        SessionCatalogCommand::Remove { session_id, catalog, json } => {
            let entry = match resolve_catalog_reference(&catalog) {
                crate::core::catalog_resolver::CatalogResolution::Found(s) => s,
                _ => {
                    eprintln!("{}: catalog not found: {}", "error".red(), catalog);
                    std::process::exit(2);
                }
            };
            let bookmark = match find_bookmark(&session_id) {
                Some(b) => b,
                None => {
                    eprintln!("{}: pin not found for session {}", "error".red(), session_id);
                    std::process::exit(1);
                }
            };
            let ids: Vec<String> = bookmark.space_ids.iter().filter(|id| *id != &entry.id).cloned().collect();
            update_bookmark(&bookmark.id, BookmarkPatch { space_ids: Some(ids), ..Default::default() });
            if json {
                let updated = find_bookmark(&bookmark.session_id).unwrap_or_else(|| bookmark.clone());
                return super::print_json_result(
                    "session.catalog.remove",
                    &format!("Removed session {} from catalog \"{}\"", short_session_id(&bookmark.session_id), entry.name),
                    serde_json::json!({ "bookmark": updated, "catalog": entry }),
                );
            }
            println!("{}", format!("Removed session {} from catalog \"{}\"", short_session_id(&bookmark.session_id), entry.name).green());
            Ok(())
        }
        SessionCatalogCommand::Clear { session_id, json } => {
            let bookmark = match find_bookmark(&session_id) {
                Some(b) => b,
                None => {
                    eprintln!("{}: pin not found for session {}", "error".red(), session_id);
                    std::process::exit(1);
                }
            };
            update_bookmark(&bookmark.id, BookmarkPatch { space_ids: Some(vec![]), ..Default::default() });
            if json {
                let updated = find_bookmark(&bookmark.session_id).unwrap_or_else(|| bookmark.clone());
                return super::print_json_result(
                    "session.catalog.clear",
                    &format!("Cleared catalogs for session {}", short_session_id(&bookmark.session_id)),
                    serde_json::json!({ "bookmark": updated }),
                );
            }
            println!("{}", format!("Cleared catalogs for session {}", short_session_id(&bookmark.session_id)).green());
            Ok(())
        }
    }
}
