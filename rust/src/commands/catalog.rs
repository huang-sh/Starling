//! `starling catalog` (alias: `space`) — manage catalogs and assignments.

use anyhow::Result;
use colored::*;

use crate::cli::*;
use crate::core::catalog_resolver::{catalog_path, resolve_catalog_reference, CatalogResolution};
use crate::core::format::{format_bookmark_detail, format_space_tree};
use crate::core::id::generate_space_id;
use crate::core::session_display::short_session_id;
use crate::core::store::{
    add_space, find_space, has_sibling_space_name, list_bookmarks, list_spaces, remove_space,
    update_space, BookmarkFilter, BookmarkPatch, SpacePatch,
};
use crate::types::Space;

pub fn handle(cmd: CatalogCommand) -> Result<()> {
    match cmd {
        CatalogCommand::Create { name, description, parent } => create(&name, description, parent.as_deref()),
        CatalogCommand::List { json } => list(json),
        CatalogCommand::Tree => tree(),
        CatalogCommand::Add { catalog, session_id, title, tags } => add(&catalog, &session_id, title, tags),
        CatalogCommand::Show { name } => show(&name),
        CatalogCommand::Detach { catalog, session_id } => detach(&catalog, &session_id),
        CatalogCommand::Clear { catalog } => clear(&catalog),
        CatalogCommand::Delete { catalog, yes } => delete(&catalog, yes),
        CatalogCommand::Tag { name, tags } => tag(&name, &tags),
        CatalogCommand::Rename { catalog, new_name } => rename(&catalog, &new_name),
        CatalogCommand::Move { catalog, parent } => mv(&catalog, parent.as_deref()),
        CatalogCommand::Edit { name } => edit(&name),
    }
}

fn resolve_or_exit(r: &str) -> Space {
    match resolve_catalog_reference(r) {
        CatalogResolution::Found(s) => s,
        CatalogResolution::Ambiguous(matches) => {
            eprintln!("{}: ambiguous catalog '{}': {}", "error".red(), r,
                matches.iter().map(|s| s.name.clone()).collect::<Vec<_>>().join(", "));
            std::process::exit(2);
        }
        CatalogResolution::NotFound => {
            eprintln!("{}: catalog not found: {}", "error".red(), r);
            std::process::exit(2);
        }
    }
}

fn create(name: &str, description: Option<String>, parent: Option<&str>) -> Result<()> {
    let parent_id = match parent {
        Some(p) => {
            let ps = resolve_or_exit(p);
            Some(ps.id)
        }
        None => None,
    };
    if has_sibling_space_name(name, parent_id.as_deref(), None) {
        eprintln!("{}: a sibling catalog already named \"{}\" exists", "error".red(), name);
        std::process::exit(2);
    }
    let spaces = list_spaces();
    let id = generate_space_id(&spaces);
    let now = crate::constants::now_iso();
    let space = Space {
        id,
        name: name.to_string(),
        description: description.unwrap_or_default(),
        tags: vec![],
        parent_id,
        created_at: now.clone(),
        updated_at: now,
    };
    add_space(space.clone());
    println!("{}", format!("Created catalog: {} ({})", space.name, space.id).green());
    Ok(())
}

fn list(json: bool) -> Result<()> {
    let spaces = list_spaces();
    if json {
        println!("{}", serde_json::to_string_pretty(&spaces)?);
        return Ok(());
    }
    if spaces.is_empty() {
        println!("{}", "No catalogs created yet.".yellow());
        return Ok(());
    }
    let bookmarks = list_bookmarks(BookmarkFilter::default());
    let spaces_clone = spaces.clone();
    for s in spaces {
        let count = bookmarks.iter().filter(|b| b.space_ids.contains(&s.id)).count();
        let path = catalog_path(&s, Some(&spaces_clone));
        let tags = if s.tags.is_empty() { String::new() } else { format!(" [{}]", s.tags.join(", ")) };
        println!("{} {} {} {}", s.id.cyan(), path.bold(), format!("({} sessions)", count).normal(), tags.normal());
    }
    Ok(())
}

fn tree() -> Result<()> {
    let spaces = list_spaces();
    let bookmarks = list_bookmarks(BookmarkFilter::default());
    println!("{}", crate::core::format::format_space_tree(&spaces, &bookmarks));
    Ok(())
}

fn add(catalog: &str, session_id: &str, title: Option<String>, tags: Option<String>) -> Result<()> {
    super::session::handle(SessionCommand::Catalog(SessionCatalogCommand::Add {
        session_id: session_id.to_string(),
        catalog: catalog.to_string(),
        title,
        tags,
    }))
}

fn show(name: &str) -> Result<()> {
    let space = resolve_or_exit(name);
    let spaces = list_spaces();
    let bookmarks: Vec<_> = list_bookmarks(BookmarkFilter::default()).into_iter()
        .filter(|b| b.space_ids.contains(&space.id))
        .collect();
    println!("{}", format!("Catalog: {}", catalog_path(&space, Some(&spaces))).cyan().bold());
    println!("  ID:          {}", space.id);
    println!("  Description: {}", if space.description.is_empty() { "-".into() } else { space.description });
    println!("  Tags:        {}", if space.tags.is_empty() { "-".into() } else { space.tags.join(", ") });
    println!("  Created:     {}", space.created_at);
    println!("  Sessions:    {}", bookmarks.len());
    for b in &bookmarks {
        println!("    {} {} {}",
            b.id.cyan(),
            short_session_id(&b.session_id).normal(),
            b.title);
    }
    Ok(())
}

fn detach(catalog: &str, session_id: &str) -> Result<()> {
    super::session::handle(SessionCommand::Catalog(SessionCatalogCommand::Remove {
        session_id: session_id.to_string(),
        catalog: catalog.to_string(),
    }))
}

fn clear(catalog: &str) -> Result<()> {
    let space = resolve_or_exit(catalog);
    let bookmarks: Vec<_> = list_bookmarks(BookmarkFilter::default()).into_iter()
        .filter(|b| b.space_ids.contains(&space.id))
        .collect();
    if bookmarks.is_empty() {
        println!("{}", format!("Catalog \"{}\" has no sessions to clear.", space.name).yellow());
        return Ok(());
    }
    let mut count = 0;
    for b in &bookmarks {
        let new_ids: Vec<String> = b.space_ids.iter().filter(|id| *id != &space.id).cloned().collect();
        crate::core::store::update_bookmark(&b.id, BookmarkPatch { space_ids: Some(new_ids), ..Default::default() });
        count += 1;
    }
    println!("{}", format!("Cleared {} sessions from \"{}\"", count, space.name).green());
    Ok(())
}

fn delete(catalog: &str, yes: bool) -> Result<()> {
    let space = resolve_or_exit(catalog);
    if !yes {
        eprintln!("{}: deleting a catalog requires --yes (would also detach {} sessions)",
            "error".red(),
            list_bookmarks(BookmarkFilter::default()).iter().filter(|b| b.space_ids.contains(&space.id)).count());
        std::process::exit(2);
    }
    if remove_space(&space.id) {
        println!("{}", format!("Deleted catalog: {} ({})", space.name, space.id).green());
    } else {
        eprintln!("{}: catalog could not be deleted", "error".red());
        std::process::exit(1);
    }
    Ok(())
}

fn tag(name: &str, tags: &[String]) -> Result<()> {
    let space = resolve_or_exit(name);
    let mut merged = space.tags.clone();
    for t in tags {
        if !merged.contains(t) { merged.push(t.clone()); }
    }
    update_space(&space.id, SpacePatch { tags: Some(merged.clone()), ..Default::default() });
    println!("{}", format!("Tagged \"{}\": [{}]", space.name, merged.join(", ")).green());
    Ok(())
}

fn rename(catalog: &str, new_name: &str) -> Result<()> {
    let space = resolve_or_exit(catalog);
    if has_sibling_space_name(new_name, space.parent_id.as_deref(), Some(&space.id)) {
        eprintln!("{}: a sibling catalog already named \"{}\" exists", "error".red(), new_name);
        std::process::exit(2);
    }
    update_space(&space.id, SpacePatch { name: Some(new_name.to_string()), ..Default::default() });
    println!("{}", format!("Renamed catalog: {} → {}", space.name, new_name).green());
    Ok(())
}

fn mv(catalog: &str, parent: Option<&str>) -> Result<()> {
    let space = resolve_or_exit(catalog);
    let new_parent_id = match parent {
        Some(p) => Some(resolve_or_exit(p).id),
        None => None,
    };
    // cycle check
    if let Some(pid) = &new_parent_id {
        if pid == &space.id {
            eprintln!("{}: a catalog cannot be its own parent", "error".red());
            std::process::exit(2);
        }
        // Walk up from new parent, ensure space.id not in chain
        let spaces = list_spaces();
        let mut cursor = pid.clone();
        let mut seen = std::collections::HashSet::new();
        while let Some(s) = spaces.iter().find(|x| x.id == cursor) {
            if !seen.insert(s.id.clone()) { break; }
            if s.id == space.id {
                eprintln!("{}: cycle detected moving into descendant", "error".red());
                std::process::exit(2);
            }
            cursor = match &s.parent_id { Some(p) => p.clone(), None => break };
        }
    }
    if has_sibling_space_name(&space.name, new_parent_id.as_deref(), Some(&space.id)) {
        eprintln!("{}: a sibling catalog already named \"{}\" exists", "error".red(), space.name);
        std::process::exit(2);
    }
    update_space(&space.id, SpacePatch { parent_id: Some(new_parent_id), ..Default::default() });
    println!("{}", format!("Moved catalog: {}", space.name).green());
    Ok(())
}

fn edit(_name: &str) -> Result<()> {
    eprintln!("{}", "Interactive edit is not implemented in the Rust version yet.".yellow());
    Ok(())
}

// Silence unused warning
#[allow(dead_code)]
fn _anchor_detail(b: &crate::types::Bookmark) -> String {
    format_bookmark_detail(b)
}

// Silence unused warning
#[allow(dead_code)]
fn _anchor_find_space(n: &str) -> Option<Space> {
    find_space(n)
}
