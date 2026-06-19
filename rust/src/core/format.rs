//! Table rendering — mirrors src/lib/format.ts.

use std::collections::HashMap;

use colored::*;

use crate::core::runs::{status_badge, RunStatus};
use crate::core::session_display::short_session_id;
use crate::types::{Bookmark, SessionMeta, Space};

fn fmt_token(v: Option<u64>) -> String {
    match v {
        Some(n) => n.to_string(),
        None => "-".to_string(),
    }
}

fn truncate_left(s: &str, max: usize) -> String {
    let len = s.chars().count();
    if len <= max { return s.to_string(); }
    let suffix: String = s.chars().skip(len.saturating_sub(max - 1)).collect();
    format!("…{suffix}")
}

fn truncate_right(s: &str, max: usize) -> String {
    let len = s.chars().count();
    if len <= max { return s.to_string(); }
    let prefix: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{prefix}…")
}

/// Build the canonical session list table as plain text. `status_map` optional.
pub fn format_session_table(sessions: &[SessionMeta], status_map: Option<&HashMap<String, RunStatus>>) -> String {
    use comfy_table::{Cell, Color, ContentArrangement, Table, presets::UTF8_FULL};
    let has_status = status_map.is_some();
    let mut table = Table::new();
    table
        .load_preset(UTF8_FULL)
        .set_content_arrangement(ContentArrangement::Disabled);

    let mut headers: Vec<Cell> = vec![Cell::new("Session ID").fg(Color::Cyan)];
    if has_status { headers.push(Cell::new("Status").fg(Color::Cyan)); }
    headers.extend([
        Cell::new("Agent").fg(Color::Cyan),
        Cell::new("Model").fg(Color::Cyan),
        Cell::new("Project").fg(Color::Cyan),
        Cell::new("Modified").fg(Color::Cyan),
        Cell::new("Input").fg(Color::Cyan),
        Cell::new("Output").fg(Color::Cyan),
        Cell::new("Total").fg(Color::Cyan),
        Cell::new("Cache").fg(Color::Cyan),
    ]);
    table.set_header(headers);

    for s in sessions {
        let short_id = short_session_id(&s.session_id);
        let agent = if s.provider == "codex" { "codex" } else { "claude" };
        let short_project = if s.project_path.is_empty() {
            "-".to_string()
        } else {
            truncate_left(&s.project_path, 36)
        };
        let short_date = s.modified_at.chars().take(19).collect::<String>().replace('T', " ");
        let model = if s.model.is_empty() { "-".to_string() } else { s.model.clone() };

        let tokens = s.token_usage.as_ref();

        let mut row: Vec<Cell> = vec![Cell::new(short_id)];
        if has_status {
            let st = status_map.and_then(|m| m.get(&s.session_id)).copied().unwrap_or(RunStatus::Unknown);
            row.push(Cell::new(status_badge(st, false)));
        }
        row.extend([
            Cell::new(agent),
            Cell::new(model),
            Cell::new(short_project),
            Cell::new(short_date),
            Cell::new(fmt_token(tokens.and_then(|t| t.input_tokens))),
            Cell::new(fmt_token(tokens.and_then(|t| t.output_tokens))),
            Cell::new(fmt_token(tokens.and_then(|t| t.total_tokens))),
            Cell::new(fmt_token(tokens.and_then(|t| t.cache_tokens))),
        ]);
        table.add_row(row);
    }
    table.to_string()
}

pub fn format_bookmark_table(bookmarks: &[Bookmark]) -> String {
    use comfy_table::{Cell, Color, ContentArrangement, Table, presets::UTF8_FULL};
    let mut table = Table::new();
    table
        .load_preset(UTF8_FULL)
        .set_content_arrangement(ContentArrangement::Disabled);
    table.set_header(vec![
        Cell::new("ID").fg(Color::Green),
        Cell::new("Title").fg(Color::Green),
        Cell::new("Category").fg(Color::Green),
        Cell::new("Tags").fg(Color::Green),
        Cell::new("Created").fg(Color::Green),
    ]);

    for b in bookmarks {
        let title = truncate_right(&b.title, 28);
        let tags = if b.tags.is_empty() { "-".to_string() } else { b.tags.join(", ") };
        let category = if b.category.is_empty() { "-".to_string() } else { b.category.clone() };
        let date = b.created_at.chars().take(19).collect::<String>().replace('T', " ");
        table.add_row(vec![
            Cell::new(&b.id),
            Cell::new(title),
            Cell::new(category),
            Cell::new(tags),
            Cell::new(date),
        ]);
    }
    table.to_string()
}

pub fn wrap_text(text: &str, width: usize, indent: &str) -> String {
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let candidate = if current.is_empty() { word.to_string() } else { format!("{current} {word}") };
        if candidate.chars().count() > width {
            if !current.is_empty() { lines.push(std::mem::take(&mut current)); }
            current = format!("{indent}{word}");
        } else {
            current = candidate;
        }
    }
    if !current.trim().is_empty() { lines.push(current); }
    lines.join("\n")
}

pub fn format_bookmark_detail(b: &Bookmark) -> String {
    let mut lines: Vec<String> = vec![
        format!("{}", "Pin:".bold().green()),
        format!("  Title:       {}", b.title),
        format!("  Provider:    {}", b.provider),
        format!("  Session:     {}", b.session_id),
        format!("  Category:    {}", if b.category.is_empty() { "(none)".to_string() } else { b.category.clone() }),
        format!("  Tags:        {}", if b.tags.is_empty() { "(none)".to_string() } else { b.tags.join(", ") }),
        format!("  Project:     {}", b.project_path),
        format!("  First Prompt:{}",
            if b.first_prompt.is_empty() {
                " (none)".to_string()
            } else {
                format!("\n    {}", wrap_text(&b.first_prompt, 60, "    "))
            }),
        format!("  Created:     {}", b.created_at),
        format!("  Updated:     {}", b.updated_at),
    ];
    if !b.space_ids.is_empty() {
        lines.push(format!("  Catalogs:    {}", b.space_ids.join(", ")));
    }
    if !b.notes.is_empty() {
        lines.push(format!("{}", "  Notes:".bold()));
        for n in &b.notes {
            lines.push(format!("    [{}] {}", n.id, wrap_text(&n.content, 56, "      ")));
            lines.push(format!("      {}", n.created_at.normal()));
        }
    }
    lines.join("\n")
}

/// `starling` tree of catalogs + pinned sessions.
pub fn format_space_tree(spaces: &[Space], bookmarks: &[Bookmark]) -> String {
    if spaces.is_empty() {
        return "No catalogs created yet.".yellow().to_string();
    }

    let mut children_map: HashMap<Option<String>, Vec<&Space>> = HashMap::new();
    for s in spaces {
        children_map.entry(s.parent_id.clone()).or_default().push(s);
    }

    let mut bookmark_by_space: HashMap<String, Vec<&Bookmark>> = HashMap::new();
    for b in bookmarks {
        for sid in &b.space_ids {
            bookmark_by_space.entry(sid.clone()).or_default().push(b);
        }
    }

    // Stable sort children by name
    for v in children_map.values_mut() {
        v.sort_by(|a, b| a.name.cmp(&b.name));
    }

    fn render_node(
        space: &Space,
        prefix: &str,
        is_last: bool,
        children_map: &HashMap<Option<String>, Vec<&Space>>,
        bookmark_by_space: &HashMap<String, Vec<&Bookmark>>,
    ) -> Vec<String> {
        let connector = if is_last { "└── " } else { "├── " };
        let mut lines: Vec<String> = Vec::new();
        let tag_str = if space.tags.is_empty() {
            String::new()
        } else {
            format!(" {}", format!("[{}]", space.tags.join(", ")).normal())
        };
        lines.push(format!("{prefix}{connector}{}{tag_str}", space.name.bold()));

        let child_prefix = format!("{prefix}{}", if is_last { "    " } else { "│   " });

        let bk_opt = bookmark_by_space.get(&space.id);
        let bk_len = bk_opt.map(|v| v.len()).unwrap_or(0);
        let child_len = children_map.get(&Some(space.id.clone())).map(|v| v.len()).unwrap_or(0);

        if let Some(bk) = bk_opt {
            for (i, b) in bk.iter().enumerate() {
                let b_is_last = i + 1 == bk_len && child_len == 0;
                let b_conn = if b_is_last { "└── " } else { "├── " };
                lines.push(format!("{child_prefix}{b_conn}{} {}",
                    b.title.cyan(),
                    format!("[{}]", b.session_id).normal()));
            }
        }

        if let Some(children) = children_map.get(&Some(space.id.clone())) {
            for (i, child) in children.iter().enumerate() {
                let child_is_last = i + 1 == child_len && bk_len == 0;
                let nested = render_node(child, &child_prefix, child_is_last, children_map, bookmark_by_space);
                lines.extend(nested);
            }
        }

        lines
    }

    let mut lines: Vec<String> = vec!["starling".bold().to_string()];
    let roots = children_map.get(&None).cloned().unwrap_or_default();
    for (i, root) in roots.iter().enumerate() {
        let is_last = i + 1 == roots.len();
        lines.extend(render_node(root, "", is_last, &children_map, &bookmark_by_space));
    }
    lines.join("\n")
}
