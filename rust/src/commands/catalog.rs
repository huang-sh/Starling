//! `starling catalog` (alias: `space`) — manage catalogs and assignments.

use anyhow::Result;
use colored::*;

use crate::cli::*;
use crate::core::catalog_resolver::{catalog_path, resolve_catalog_reference, CatalogResolution};
use crate::core::discovery::canonical_session_id;
use crate::core::format::{format_bookmark_detail, format_space_tree};
use crate::core::id::generate_space_id;
use crate::core::session_display::short_session_id;
use crate::core::store::{
    add_space, find_space, has_sibling_space_name, list_bookmarks, list_spaces, remove_space,
    update_space, BookmarkFilter, BookmarkPatch, SpacePatch,
};
use crate::types::{Bookmark, Space};

pub fn handle(cmd: CatalogCommand) -> Result<()> {
    match cmd {
        CatalogCommand::Create {
            name,
            description,
            tags,
            parent,
            json,
        } => create(&name, description, tags, parent.as_deref(), json),
        CatalogCommand::List { json, pins } => list(json, pins),
        CatalogCommand::Tree { sessions } => tree(sessions),
        CatalogCommand::Add {
            catalog,
            session_id,
            title,
            tags,
            json,
        } => add(&catalog, &session_id, title, tags, json),
        CatalogCommand::Show { name } => show(&name),
        CatalogCommand::Detach {
            catalog,
            session_id,
            json,
        } => detach(&catalog, &session_id, json),
        CatalogCommand::Clear { catalog, json } => clear(&catalog, json),
        CatalogCommand::Delete { catalog, yes, json } => delete(&catalog, yes, json),
        CatalogCommand::Tag { name, tags, json } => tag(&name, &tags, json),
        CatalogCommand::Rename {
            catalog,
            new_name,
            json,
        } => rename(&catalog, &new_name, json),
        CatalogCommand::Move {
            catalog,
            parent,
            json,
        } => mv(&catalog, parent.as_deref(), json),
        CatalogCommand::Edit {
            name,
            description,
            rename,
            parent,
            json,
        } => edit(&name, description, rename, parent, json),
    }
}

fn resolve_or_exit(r: &str) -> Space {
    match resolve_catalog_reference(r) {
        CatalogResolution::Found(s) => s,
        CatalogResolution::Ambiguous(matches) => {
            eprintln!(
                "{}: ambiguous catalog '{}': {}",
                "error".red(),
                r,
                matches
                    .iter()
                    .map(|s| s.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            std::process::exit(2);
        }
        CatalogResolution::NotFound => {
            eprintln!("{}: catalog not found: {}", "error".red(), r);
            std::process::exit(2);
        }
    }
}

fn parse_tags(tags: Option<String>) -> Vec<String> {
    tags.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn create(
    name: &str,
    description: Option<String>,
    tags: Option<String>,
    parent: Option<&str>,
    json: bool,
) -> Result<()> {
    let parent_id = match parent {
        Some(p) => {
            let ps = resolve_or_exit(p);
            Some(ps.id)
        }
        None => None,
    };
    if has_sibling_space_name(name, parent_id.as_deref(), None) {
        eprintln!(
            "{}: a sibling catalog already named \"{}\" exists",
            "error".red(),
            name
        );
        std::process::exit(2);
    }
    let spaces = list_spaces();
    let id = generate_space_id(&spaces);
    let now = crate::constants::now_iso();
    let space = Space {
        id,
        name: name.to_string(),
        description: description.unwrap_or_default(),
        tags: parse_tags(tags),
        parent_id,
        created_at: now.clone(),
        updated_at: now,
    };
    add_space(space.clone());
    if json {
        return super::print_json_result(
            "catalog.create",
            &format!("Created catalog: {} ({})", space.name, space.id),
            serde_json::json!({ "catalog": space }),
        );
    }
    println!(
        "{}",
        format!("Created catalog: {} ({})", space.name, space.id).green()
    );
    Ok(())
}

#[derive(serde::Serialize)]
struct SpaceWithPins {
    #[serde(flatten)]
    space: Space,
    pins: Vec<Bookmark>,
    pin_count: usize,
    session_count: usize,
}

fn spaces_with_pins(spaces: &[Space], bookmarks: &[Bookmark]) -> Vec<SpaceWithPins> {
    spaces
        .iter()
        .cloned()
        .map(|space| {
            let pins: Vec<Bookmark> = bookmarks
                .iter()
                .filter(|b| b.space_ids.contains(&space.id))
                .cloned()
                .collect();
            let pin_count = pins.len();
            SpaceWithPins {
                space,
                pins,
                pin_count,
                session_count: pin_count,
            }
        })
        .collect()
}

fn list(json: bool, pins: bool) -> Result<()> {
    let spaces = list_spaces();
    let bookmarks = list_bookmarks(BookmarkFilter::default());
    if json {
        if pins {
            println!(
                "{}",
                serde_json::to_string_pretty(&spaces_with_pins(&spaces, &bookmarks))?
            );
        } else {
            println!("{}", serde_json::to_string_pretty(&spaces)?);
        }
        return Ok(());
    }
    if spaces.is_empty() {
        println!("{}", "No catalogs created yet.".yellow());
        return Ok(());
    }
    if pins {
        println!("{}", format_space_tree(&spaces, &bookmarks));
        return Ok(());
    }
    let spaces_clone = spaces.clone();
    for s in spaces {
        let count = bookmarks
            .iter()
            .filter(|b| b.space_ids.contains(&s.id))
            .count();
        let path = catalog_path(&s, Some(&spaces_clone));
        let tags = if s.tags.is_empty() {
            String::new()
        } else {
            format!(" [{}]", s.tags.join(", "))
        };
        println!(
            "{} {} {} {}",
            s.id.cyan(),
            path.bold(),
            format!("({} sessions)", count).normal(),
            tags.normal()
        );
    }
    Ok(())
}

fn tree(sessions: bool) -> Result<()> {
    let spaces = list_spaces();
    let bookmarks = if sessions {
        list_bookmarks(BookmarkFilter::default())
    } else {
        Vec::new()
    };
    println!("{}", format_space_tree(&spaces, &bookmarks));
    Ok(())
}

fn add(
    catalog: &str,
    session_id: &str,
    title: Option<String>,
    tags: Option<String>,
    json: bool,
) -> Result<()> {
    super::session::handle(SessionCommand::Catalog(SessionCatalogCommand::Add {
        session_id: session_id.to_string(),
        catalog: catalog.to_string(),
        title,
        tags,
        json,
    }))
}

fn show(name: &str) -> Result<()> {
    let space = resolve_or_exit(name);
    let spaces = list_spaces();
    let bookmarks: Vec<_> = list_bookmarks(BookmarkFilter::default())
        .into_iter()
        .filter(|b| b.space_ids.contains(&space.id))
        .collect();
    println!(
        "{}",
        format!("Catalog: {}", catalog_path(&space, Some(&spaces)))
            .cyan()
            .bold()
    );
    println!("  ID:          {}", space.id);
    println!(
        "  Description: {}",
        if space.description.is_empty() {
            "-".into()
        } else {
            space.description
        }
    );
    println!(
        "  Tags:        {}",
        if space.tags.is_empty() {
            "-".into()
        } else {
            space.tags.join(", ")
        }
    );
    println!("  Created:     {}", space.created_at);
    println!("  Sessions:    {}", bookmarks.len());
    for b in &bookmarks {
        let session_id = canonical_session_id(&b.session_id);
        println!(
            "    {} {} {}",
            b.id.cyan(),
            short_session_id(&session_id).normal(),
            b.title
        );
    }
    Ok(())
}

fn detach(catalog: &str, session_id: &str, json: bool) -> Result<()> {
    super::session::handle(SessionCommand::Catalog(SessionCatalogCommand::Remove {
        session_id: session_id.to_string(),
        catalog: catalog.to_string(),
        json,
    }))
}

fn clear(catalog: &str, json: bool) -> Result<()> {
    let space = resolve_or_exit(catalog);
    let bookmarks: Vec<_> = list_bookmarks(BookmarkFilter::default())
        .into_iter()
        .filter(|b| b.space_ids.contains(&space.id))
        .collect();
    if bookmarks.is_empty() {
        if json {
            return super::print_json_result(
                "catalog.clear",
                &format!("Catalog \"{}\" has no sessions to clear.", space.name),
                serde_json::json!({ "catalog": space, "cleared": 0 }),
            );
        }
        println!(
            "{}",
            format!("Catalog \"{}\" has no sessions to clear.", space.name).yellow()
        );
        return Ok(());
    }
    let mut count = 0;
    for b in &bookmarks {
        let new_ids: Vec<String> = b
            .space_ids
            .iter()
            .filter(|id| *id != &space.id)
            .cloned()
            .collect();
        crate::core::store::update_bookmark(
            &b.id,
            BookmarkPatch {
                space_ids: Some(new_ids),
                ..Default::default()
            },
        );
        count += 1;
    }
    if json {
        return super::print_json_result(
            "catalog.clear",
            &format!("Cleared {} sessions from \"{}\"", count, space.name),
            serde_json::json!({ "catalog": space, "cleared": count }),
        );
    }
    println!(
        "{}",
        format!("Cleared {} sessions from \"{}\"", count, space.name).green()
    );
    Ok(())
}

fn delete(catalog: &str, yes: bool, json: bool) -> Result<()> {
    let space = resolve_or_exit(catalog);
    if !yes {
        eprintln!(
            "{}: deleting a catalog requires --yes (would also detach {} sessions)",
            "error".red(),
            list_bookmarks(BookmarkFilter::default())
                .iter()
                .filter(|b| b.space_ids.contains(&space.id))
                .count()
        );
        std::process::exit(2);
    }
    if remove_space(&space.id) {
        if json {
            return super::print_json_result(
                "catalog.delete",
                &format!("Deleted catalog: {} ({})", space.name, space.id),
                serde_json::json!({ "catalog": space, "deleted": true }),
            );
        }
        println!(
            "{}",
            format!("Deleted catalog: {} ({})", space.name, space.id).green()
        );
    } else {
        eprintln!("{}: catalog could not be deleted", "error".red());
        std::process::exit(1);
    }
    Ok(())
}

fn tag(name: &str, tags: &[String], json: bool) -> Result<()> {
    let space = resolve_or_exit(name);
    let catalog_name = space.name.clone();
    let mut merged = space.tags.clone();
    for t in tags {
        if !merged.contains(t) {
            merged.push(t.clone());
        }
    }
    let updated = update_space(
        &space.id,
        SpacePatch {
            tags: Some(merged.clone()),
            ..Default::default()
        },
    )
    .unwrap_or(space);
    if json {
        return super::print_json_result(
            "catalog.tag",
            &format!("Tagged \"{}\": [{}]", updated.name, merged.join(", ")),
            serde_json::json!({ "catalog": updated }),
        );
    }
    println!(
        "{}",
        format!("Tagged \"{}\": [{}]", catalog_name, merged.join(", ")).green()
    );
    Ok(())
}

fn rename(catalog: &str, new_name: &str, json: bool) -> Result<()> {
    let space = resolve_or_exit(catalog);
    if has_sibling_space_name(new_name, space.parent_id.as_deref(), Some(&space.id)) {
        eprintln!(
            "{}: a sibling catalog already named \"{}\" exists",
            "error".red(),
            new_name
        );
        std::process::exit(2);
    }
    let old_name = space.name.clone();
    let updated = update_space(
        &space.id,
        SpacePatch {
            name: Some(new_name.to_string()),
            ..Default::default()
        },
    )
    .unwrap_or(space);
    if json {
        return super::print_json_result(
            "catalog.rename",
            &format!("Renamed catalog: {} -> {}", old_name, new_name),
            serde_json::json!({ "catalog": updated, "old_name": old_name }),
        );
    }
    println!(
        "{}",
        format!("Renamed catalog: {} → {}", old_name, new_name).green()
    );
    Ok(())
}

fn mv(catalog: &str, parent: Option<&str>, json: bool) -> Result<()> {
    let space = resolve_or_exit(catalog);
    let catalog_name = space.name.clone();
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
            if !seen.insert(s.id.clone()) {
                break;
            }
            if s.id == space.id {
                eprintln!("{}: cycle detected moving into descendant", "error".red());
                std::process::exit(2);
            }
            cursor = match &s.parent_id {
                Some(p) => p.clone(),
                None => break,
            };
        }
    }
    if has_sibling_space_name(&space.name, new_parent_id.as_deref(), Some(&space.id)) {
        eprintln!(
            "{}: a sibling catalog already named \"{}\" exists",
            "error".red(),
            space.name
        );
        std::process::exit(2);
    }
    let updated = update_space(
        &space.id,
        SpacePatch {
            parent_id: Some(new_parent_id),
            ..Default::default()
        },
    )
    .unwrap_or(space);
    if json {
        return super::print_json_result(
            "catalog.move",
            &format!("Moved catalog: {}", updated.name),
            serde_json::json!({ "catalog": updated }),
        );
    }
    println!("{}", format!("Moved catalog: {}", catalog_name).green());
    Ok(())
}

fn edit(
    name: &str,
    description: Option<String>,
    rename_to: Option<String>,
    parent: Option<String>,
    json: bool,
) -> Result<()> {
    let space = resolve_or_exit(name);
    let mut patch = SpacePatch::default();
    let mut changed = false;

    if let Some(description) = description {
        patch.description = Some(description);
        changed = true;
    }

    if let Some(new_name) = rename_to {
        if has_sibling_space_name(&new_name, space.parent_id.as_deref(), Some(&space.id)) {
            eprintln!(
                "{}: a sibling catalog already named \"{}\" exists",
                "error".red(),
                new_name
            );
            std::process::exit(2);
        }
        patch.name = Some(new_name);
        changed = true;
    }

    if let Some(parent_ref) = parent {
        let trimmed = parent_ref.trim();
        let new_parent_id =
            if trimmed.is_empty() || trimmed == "/" || trimmed.eq_ignore_ascii_case("root") {
                None
            } else {
                Some(resolve_or_exit(trimmed).id)
            };

        if let Some(pid) = &new_parent_id {
            if pid == &space.id {
                eprintln!("{}: a catalog cannot be its own parent", "error".red());
                std::process::exit(2);
            }
            let spaces = list_spaces();
            let mut cursor = pid.clone();
            let mut seen = std::collections::HashSet::new();
            while let Some(s) = spaces.iter().find(|x| x.id == cursor) {
                if !seen.insert(s.id.clone()) {
                    break;
                }
                if s.id == space.id {
                    eprintln!("{}: cycle detected moving into descendant", "error".red());
                    std::process::exit(2);
                }
                cursor = match &s.parent_id {
                    Some(p) => p.clone(),
                    None => break,
                };
            }
        }

        let effective_name = patch.name.as_deref().unwrap_or(&space.name);
        if has_sibling_space_name(effective_name, new_parent_id.as_deref(), Some(&space.id)) {
            eprintln!(
                "{}: a sibling catalog already named \"{}\" exists",
                "error".red(),
                effective_name
            );
            std::process::exit(2);
        }
        patch.parent_id = Some(new_parent_id);
        changed = true;
    }

    if !changed {
        if json {
            return super::print_json_result(
                "catalog.edit",
                "No catalog changes requested.",
                serde_json::json!({ "catalog": space, "changed": false }),
            );
        }
        println!("{}", "No catalog changes requested.".yellow());
        return Ok(());
    }

    let updated = update_space(&space.id, patch).unwrap_or(space);
    if json {
        return super::print_json_result(
            "catalog.edit",
            &format!("Updated catalog: {} ({})", updated.name, updated.id),
            serde_json::json!({ "catalog": updated, "changed": true }),
        );
    }
    println!(
        "{}",
        format!("Updated catalog: {} ({})", updated.name, updated.id).green()
    );
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
