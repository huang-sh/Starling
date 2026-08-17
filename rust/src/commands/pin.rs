//! `starling pin` — pin a session with metadata.

use anyhow::Result;
use colored::*;

use crate::commands::session::resolve_session_meta;
use crate::core::catalog_resolver::resolve_catalog_reference;
use crate::core::discovery::canonical_session_id;
use crate::core::discovery::find_sessions;
use crate::core::format::format_bookmark_detail;
use crate::core::id::generate_bookmark_id;
use crate::core::session_display::short_session_id;
use crate::core::store::{add_bookmark, BookmarkFilter};
use crate::core::store::{
    find_bookmark_for_session, list_bookmarks, update_bookmark, BookmarkPatch,
};
use crate::types::{Bookmark, SessionMeta};

pub fn run(
    session_id: Option<String>,
    title: Option<String>,
    tags: Option<String>,
    to: Option<String>,
    current: bool,
    json: bool,
) -> Result<()> {
    run_with_origin(session_id, title, tags, to, current, json, "manual")
}

pub(crate) fn run_with_origin(
    session_id: Option<String>,
    title: Option<String>,
    tags: Option<String>,
    to: Option<String>,
    current: bool,
    json: bool,
    origin: &str,
) -> Result<()> {
    if session_id.is_none() && !current {
        eprintln!(
            "{}: pass a session id, or use --current for the most recent",
            "usage".yellow()
        );
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
    let bookmark = if let Some(b) =
        find_bookmark_for_session(&meta.provider, &meta.session_id, &meta.project_path)
    {
        let mut patch = BookmarkPatch::default();
        let mut changed = false;
        if let Some(t) = title.as_deref() {
            patch.title = Some(t.to_string());
            changed = true;
        }
        if let Some(t) = tags.as_deref() {
            patch.tags = Some(
                t.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
            );
            changed = true;
        }
        if changed {
            update_bookmark(&b.id, patch).unwrap_or(b)
        } else {
            b
        }
    } else if let Some(b) = list_bookmarks(BookmarkFilter::default())
        .into_iter()
        .find(|b| {
            b.provider == meta.provider
                && (meta.provider != "pi" || b.project_path == meta.project_path)
                && canonical_session_id(&b.session_id, Some(&b.provider))
                    == canonical_session_id(&meta.session_id, Some(&meta.provider))
        })
    {
        let mut patch = BookmarkPatch {
            session_id: Some(meta.session_id.clone()),
            ..Default::default()
        };
        if let Some(t) = title.as_deref() {
            patch.title = Some(t.to_string());
        }
        if let Some(t) = tags.as_deref() {
            patch.tags = Some(
                t.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
            );
        }
        update_bookmark(&b.id, patch).unwrap_or(b)
    } else {
        let store = crate::core::store::load_store();
        let bookmark = Bookmark {
            id: generate_bookmark_id(&store.bookmarks),
            provider: meta.provider.clone(),
            session_id: meta.session_id.clone(),
            title: title.clone().unwrap_or_else(|| meta.first_prompt.clone()),
            category: String::new(),
            tags: tags
                .as_ref()
                .map(|s| {
                    s.split(',')
                        .map(|t| t.trim().to_string())
                        .filter(|t| !t.is_empty())
                        .collect()
                })
                .unwrap_or_default(),
            project_path: meta.project_path.clone(),
            first_prompt: meta.first_prompt.clone(),
            notes: vec![],
            origin: origin.to_string(),
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
                    update_bookmark(
                        &bookmark.id,
                        BookmarkPatch {
                            space_ids: Some(ids),
                            ..Default::default()
                        },
                    );
                    if !json {
                        println!(
                            "{}",
                            format!("Added to catalog: {} ({})", s.name, s.id).green()
                        );
                    }
                }
            }
            other => {
                eprintln!(
                    "{}: could not resolve catalog '{}': {:?}",
                    "error".red(),
                    c,
                    other
                );
                std::process::exit(2);
            }
        }
    }

    let updated = find_bookmark_for_session(&meta.provider, &meta.session_id, &meta.project_path)
        .unwrap_or(bookmark);
    if json {
        return super::print_json_result(
            "pin",
            &format!("Pinned session {}", short_session_id(&meta.session_id)),
            serde_json::json!({ "bookmark": updated, "session_id": meta.session_id }),
        );
    }
    println!("{}", format_bookmark_detail(&updated));
    println!(
        "\n{}: pinned session {}",
        "ok".green().bold(),
        short_session_id(&meta.session_id)
    );
    Ok(())
}

/// Claude-compatible hook endpoint: read the event JSON from stdin and
/// archive the session into a catalog named after its working directory.
/// Designed for `codex` config.toml hooks (`codex_hooks = true`), where
/// SessionStart delivers {session_id, cwd, ...}. Also works with Claude
/// Code settings.json hooks, whose payload carries the same fields.
/// Best-effort: failures print to stderr and exit 0 so the host agent is
/// never disturbed.
// ponytail: catalog name is the cwd basename — distinct projects sharing a
// basename land in one catalog; switch to hierarchical paths if that bites.
pub fn hook_run(json: bool) -> Result<()> {
    let mut raw = String::new();
    if std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw).is_err() {
        return Ok(());
    }
    archive_session_from_hook(&raw, json);
    Ok(())
}

/// Shared archive path for Claude-compatible SessionStart events: pin the
/// session into a catalog named after the payload cwd. Extracted from stdin
/// reading so `top hook` (claude) and `hook` (codex) share one implementation.
// ponytail: catalog name is the cwd basename — distinct projects sharing a
// basename land in one catalog; switch to hierarchical paths if that bites.
pub(crate) fn archive_session_from_hook(raw: &str, json: bool) {
    // Flight recorder: claude swallows hook stderr, so append a one-line
    // trace to <starling-home>/logs/hook.log for diagnosis (best-effort).
    let trace = |msg: &str| {
        use std::io::Write;
        let home = crate::constants::default_starling_home().join("logs");
        let _ = std::fs::create_dir_all(&home);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(home.join("hook.log"))
        {
            let _ = f.write_all(format!("{} {}\n", crate::constants::now_iso(), msg).as_bytes());
        }
    };
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(raw.trim()) else {
        trace("parse-failed");
        return;
    };
    let Some(session_id) = payload.get("session_id").and_then(|v| v.as_str()) else {
        trace("no-session-id");
        return;
    };
    if session_id.trim().is_empty() {
        return;
    }
    let cwd = payload
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let Some(catalog_name) = std::path::Path::new(cwd)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_string())
    else {
        return;
    };
    // pin::run exits the process on lookup failure; probe first so the
    // hook can stay best-effort. Claude fires SessionStart BEFORE creating
    // the transcript, and resolving an unknown id costs ~9s of full provider
    // scan — over the 5s hook timeout, which is exactly why live sessions
    // got killed before archiving. Pre-create from the payload path FIRST
    // (claude appends to it; an empty touch is the state it would be in
    // anyway), so the subsequent resolve finds the file instantly. Only
    // when no transcript_path exists do we fall back to the (slow) resolve,
    // and skip on failure — the next event retries naturally.
    let transcript_path = payload
        .get("transcript_path")
        .and_then(|v| v.as_str())
        .filter(|p| !p.trim().is_empty())
        .map(std::path::PathBuf::from);
    let mut precreated = false;
    if let Some(p) = transcript_path.as_ref().filter(|p| {
        p.extension().and_then(|e| e.to_str()) == Some("jsonl")
    }) {
        if !p.exists() {
            precreated = std::fs::create_dir_all(p.parent().unwrap_or(std::path::Path::new("/")))
                .ok()
                .and_then(|_| {
                    std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(p)
                        .ok()
                })
                .is_some();
        } else {
            precreated = true;
        }
    }
    if !precreated && crate::commands::session::resolve_session_meta(session_id).is_none() {
        trace(&format!("unresolvable sid={session_id} cwd={cwd}"));
        eprintln!(
            "{}: starling hook: session not resolvable yet: {}",
            "error".red(),
            short_session_id(session_id)
        );
        return;
    }
    // Ensure the catalog exists (quietly), then pin into it. `pin --to`
    // already no-ops when the bookmark is present and assigned.
    if !matches!(
        resolve_catalog_reference(&catalog_name),
        crate::core::catalog_resolver::CatalogResolution::Found(_)
    ) {
        if let Err(e) = crate::commands::catalog::create(
            &catalog_name,
            Some("Auto-created from agent working directory".to_string()),
            None,
            None,
            true,
        ) {
            eprintln!("{}: starling hook: {}", "error".red(), e);
            return;
        }
    }
    match run_with_origin(
        Some(session_id.to_string()),
        None,
        None,
        Some(catalog_name),
        false,
        json,
        "auto",
    ) {
        Ok(()) => trace(&format!("pinned sid={session_id}")),
        Err(e) => {
            trace(&format!("pin-failed sid={session_id} err={e}"));
            eprintln!("{}: starling hook: {}", "error".red(), e);
        }
    }
}
