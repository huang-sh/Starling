import { ansi } from "./ansi.js";
export function getRenderPlan(args) {
    if (args.length === 0 || hasMachineOrHelpFlag(args))
        return null;
    const root = normalizeRoot(args[0]);
    const rest = args.slice(1);
    switch (root) {
        case "pin":
            return { kind: "mutationResult", rustArgs: withJson(args) };
        case "session":
            return planSession(rest);
        case "catalog":
            return planCatalog(rest);
        case "project":
            return planProject(rest);
        case "model":
            return planModel(rest);
        case "config":
            return planConfig(rest);
        case "status":
            return null;
        case "run":
            return planRun(rest);
        default:
            return null;
    }
}
export function renderCommandResult(plan, raw) {
    switch (plan.kind) {
        case "sessionList":
            return renderSessionList(asArray(raw));
        case "sessionShow":
            return renderSessionShow(asRecord(raw));
        case "sessionIndex":
            return renderKeyValue("Session index", asRecord(raw));
        case "catalogList":
            return renderCatalogList(asArray(raw));
        case "catalogTree":
            return renderCatalogTree(asArray(raw), Boolean(plan.includeSessions));
        case "catalogShow":
            return renderCatalogShow(asArray(raw), plan.query ?? "");
        case "projectList":
            return renderProjectList(asArray(raw));
        case "projectShow":
            return renderProjectShow(asRecord(raw));
        case "modelList":
            return renderModelList(asArray(raw));
        case "configShow":
            return renderKeyValue("Starling config", asRecord(raw));
        case "statusShow":
            return renderStatusList(asArray(raw));
        case "runStatus":
            return Array.isArray(raw) ? renderRunList(raw) : renderRunShow(asRecord(raw));
        case "mutationResult":
            return renderMutationResult(asRecord(raw));
    }
}
function planSession(rest) {
    const sub = normalizeSub(rest[0], "list");
    if (sub === "list") {
        return { kind: "sessionList", rustArgs: withJson(["session", "list", ...rest.slice(rest[0] ? 1 : 0)]) };
    }
    if (sub === "show" && rest[1]) {
        return { kind: "sessionShow", rustArgs: withJson(["session", "show", ...rest.slice(1)]) };
    }
    if (sub === "lookup") {
        return { kind: "sessionList", rustArgs: withJson(["session", "lookup", ...rest.slice(1)]) };
    }
    if (sub === "index") {
        const indexSub = normalizeSub(rest[1], "status");
        if (indexSub === "status") {
            return { kind: "sessionIndex", rustArgs: withJson(["session", "index", "status", ...rest.slice(rest[1] ? 2 : 1)]) };
        }
        if (indexSub === "rebuild") {
            return { kind: "sessionIndex", rustArgs: withJson(["session", "index", "rebuild", ...rest.slice(2)]) };
        }
        if (indexSub === "clear") {
            return { kind: "mutationResult", rustArgs: withJson(["session", "index", "clear", ...rest.slice(2)]) };
        }
    }
    if (sub === "catalog") {
        const catalogSub = normalizeSub(rest[1], "");
        if (catalogSub === "add" || catalogSub === "remove" || catalogSub === "rm" || catalogSub === "clear") {
            return { kind: "mutationResult", rustArgs: withJson(["session", "catalog", ...rest.slice(1)]) };
        }
    }
    if (sub === "meta" || sub === "note" || sub === "unpin" || sub === "delete") {
        return { kind: "mutationResult", rustArgs: withJson(["session", sub, ...rest.slice(1)]) };
    }
    return null;
}
function planCatalog(rest) {
    const sub = normalizeSub(rest[0], "list");
    if (sub === "list") {
        return { kind: "catalogList", rustArgs: withJson(withPins(["catalog", "list", ...rest.slice(rest[0] ? 1 : 0)])) };
    }
    if (sub === "tree") {
        const includeSessions = rest.includes("--sessions");
        const args = ["catalog", "list", "--json", "--pins"];
        return { kind: "catalogTree", rustArgs: args, includeSessions };
    }
    if (sub === "show" && rest[1]) {
        return { kind: "catalogShow", rustArgs: ["catalog", "list", "--json", "--pins"], query: rest[1] };
    }
    if (sub === "create" || sub === "add" || sub === "detach" || sub === "rm" || sub === "clear" || sub === "delete" || sub === "tag" || sub === "rename" || sub === "move" || sub === "mv" || sub === "edit") {
        return { kind: "mutationResult", rustArgs: withJson(["catalog", sub, ...rest.slice(1)]) };
    }
    return null;
}
function planProject(rest) {
    const sub = normalizeSub(rest[0], "list");
    if (sub === "list") {
        return { kind: "projectList", rustArgs: withJson(["project", "list", ...rest.slice(rest[0] ? 1 : 0)]) };
    }
    if (sub === "show" && rest[1]) {
        return { kind: "projectShow", rustArgs: withJson(["project", "show", ...rest.slice(1)]) };
    }
    return null;
}
function planModel(rest) {
    const sub = normalizeSub(rest[0], "list");
    if (sub === "list") {
        return { kind: "modelList", rustArgs: withJson(["model", "list", ...rest.slice(rest[0] ? 1 : 0)]) };
    }
    if (sub === "delete") {
        return { kind: "mutationResult", rustArgs: withJson(["model", "delete", ...rest.slice(1)]) };
    }
    return null;
}
function planConfig(rest) {
    const sub = normalizeSub(rest[0], "show");
    if (sub === "show" || sub === "list") {
        return { kind: "configShow", rustArgs: withJson(["config", "show", ...rest.slice(rest[0] ? 1 : 0)]) };
    }
    if (sub === "set" || sub === "unset") {
        return { kind: "mutationResult", rustArgs: withJson(["config", sub, ...rest.slice(1)]) };
    }
    return null;
}
function planRun(rest) {
    const sub = normalizeSub(rest[0], "");
    if (sub === "status") {
        return { kind: "runStatus", rustArgs: withJson(["run", "status", ...rest.slice(1)]) };
    }
    if (sub === "stop") {
        return { kind: "mutationResult", rustArgs: withJson(["run", "stop", ...rest.slice(1)]) };
    }
    return null;
}
function renderSessionList(rows) {
    if (rows.length === 0)
        return ansi.yellow("No sessions found.");
    return renderTable("Sessions", rows.map((row) => {
        const r = asRecord(row);
        const usage = asRecord(r.token_usage);
        return [
            shortId(str(r.session_id)),
            str(r.provider) || "-",
            str(r.model) || "-",
            compactPath(str(r.project_path), 38),
            formatDate(str(r.modified_at)),
            num(usage.input_tokens),
            num(usage.output_tokens),
            num(cacheTokens(usage)),
            num(usage.total_tokens),
        ];
    }), ["Session", "Agent", "Model", "Project", "Modified", "Input", "Output", "Cache", "Total"], true, [15, 8, 18, 40, 16, 9, 9, 9, 9]);
}
function renderSessionShow(row) {
    if (!row.session_id)
        return ansi.yellow("Session not found.");
    const usage = asRecord(row.token_usage);
    const catalogs = Array.isArray(row.catalogs)
        ? row.catalogs.map((catalog) => str(asRecord(catalog).name)).filter(Boolean).join(", ")
        : "";
    const lines = [
        `${ansi.bold("Session:")} ${ansi.cyan(str(row.session_id))}`,
        detailLine("Agent", str(row.provider) || "-"),
        detailLine("Model", str(row.model) || "-"),
        detailLine("Project", str(row.project_path) || "-"),
        detailLine("File", str(row.file_path) || "-"),
        detailLine("Modified", formatDate(str(row.modified_at))),
        detailLine("Catalogs", catalogs || "-"),
    ];
    if (Object.keys(usage).length > 0) {
        lines.push("  Token Usage:");
        lines.push(detailLine("Input", num(usage.input_tokens), 4));
        lines.push(detailLine("Output", num(usage.output_tokens), 4));
        lines.push(detailLine("Cache", num(cacheTokens(usage)), 4));
        lines.push(detailLine("Total", num(usage.total_tokens), 4));
    }
    const prompt = str(row.first_prompt);
    if (prompt) {
        lines.push("  First Prompt:");
        lines.push(`    ${truncate(prompt, 180)}`);
    }
    return lines.join("\n");
}
function renderCatalogList(rows) {
    if (rows.length === 0)
        return ansi.yellow("No catalogs created yet.");
    const spaces = rows.map(asRecord);
    return renderTable("Catalogs", spaces.map((r) => {
        return [
            str(r.id),
            str(r.name) || "-",
            num(r.session_count ?? 0),
            num(r.pin_count ?? 0),
            parentName(r, spaces),
            truncate(str(r.description), 28) || "-",
            tagsText(r.tags),
        ];
    }), ["Catalog ID", "Name", "Sessions", "Pins", "Parent", "Description", "Tags"], true, [18, 20, 8, 6, 16, 30, 22]);
}
function renderCatalogTree(rows, includeSessions) {
    const spaces = rows.map(asRecord);
    if (spaces.length === 0)
        return ansi.yellow("No catalogs created yet.");
    const byParent = new Map();
    for (const space of spaces) {
        const parent = typeof space.parent_id === "string" ? space.parent_id : "";
        const children = byParent.get(parent) ?? [];
        children.push(space);
        byParent.set(parent, children);
    }
    const lines = [ansi.bold("starling")];
    const walk = (parent, prefix) => {
        const children = (byParent.get(parent) ?? []).sort((a, b) => str(a.name).localeCompare(str(b.name)));
        children.forEach((space, index) => {
            const last = index === children.length - 1;
            const branch = last ? "└── " : "├── ";
            const childPrefix = `${prefix}${last ? "    " : "│   "}`;
            const count = Number(space.session_count ?? space.pin_count ?? 0);
            const tags = tagsText(space.tags);
            lines.push(`${prefix}${branch}${ansi.bold(str(space.name))} ${ansi.dim(`${count} sessions${tags ? ` [${tags}]` : ""}`)}`);
            if (includeSessions) {
                const pins = Array.isArray(space.pins) ? space.pins.map(asRecord) : [];
                pins.forEach((pin, pinIndex) => {
                    const pinLast = pinIndex === pins.length - 1 && (byParent.get(str(space.id)) ?? []).length === 0;
                    const pinBranch = pinLast ? "└── " : "├── ";
                    const sessionId = canonicalSessionId(str(pin.session_id));
                    const title = truncate(str(pin.title) || str(pin.first_prompt) || shortId(sessionId), 72);
                    lines.push(`${childPrefix}${pinBranch}${title} ${ansi.gray(`[${shortId(sessionId)}]`)}`);
                });
            }
            walk(str(space.id), childPrefix);
        });
    };
    walk("", "");
    return lines.join("\n");
}
function renderCatalogShow(rows, query) {
    const spaces = rows.map(asRecord);
    const found = resolveCatalog(spaces, query);
    if (!found)
        return ansi.yellow(`Catalog not found: ${query}`);
    const pins = Array.isArray(found.pins) ? found.pins.map(asRecord) : [];
    const lines = [
        `${ansi.bold("Catalog:")} ${ansi.cyan(catalogPath(found, spaces))}`,
        detailLine("ID", str(found.id)),
        detailLine("Description", str(found.description) || "-"),
        detailLine("Parent", parentName(found, spaces)),
        detailLine("Pins", num(found.pin_count ?? pins.length)),
        detailLine("Sessions", num(found.session_count ?? pins.length)),
        detailLine("Tags", tagsText(found.tags) || "-"),
        detailLine("Updated", formatDate(str(found.updated_at))),
    ];
    for (const pin of pins) {
        const sessionId = canonicalSessionId(str(pin.session_id));
        const title = truncate(str(pin.title) || str(pin.first_prompt), 86) || "-";
        lines.push(`  ${ansi.cyan(shortId(sessionId))}  ${title} ${ansi.gray(str(pin.provider) || "")}`);
    }
    return lines.join("\n");
}
function renderProjectList(rows) {
    if (rows.length === 0)
        return ansi.yellow("No projects found.");
    return renderTable("Projects", rows.map((row) => {
        const r = asRecord(row);
        return [
            compactPath(str(r.project_path), 46),
            num(r.session_count),
            formatAgentModelSummary(r.agents),
            topCountKey(r.models),
            formatDate(str(r.last_active)),
        ];
    }), ["PROJECT", "SESSIONS", "AGENTS", "TOP MODEL", "LAST ACTIVE"], true, [48, 8, 26, 22, 16]);
}
function renderProjectShow(row) {
    const sessions = Array.isArray(row.sessions) ? row.sessions.map(asRecord) : [];
    if (!row.project_path && sessions.length === 0)
        return ansi.yellow("No sessions for project.");
    const lines = [
        `${ansi.bold("Project:")} ${ansi.cyan(str(row.project_path) || "-")}`,
        detailLine("Sessions", num(row.session_count ?? sessions.length)),
        detailLine("Agents", formatAgentModelSummary(row.agents) || "-"),
        detailLine("Models", formatAgentModelSummary(row.models) || "-"),
        detailLine("First session", formatDate(str(row.first_active))),
        detailLine("Last active", formatDate(str(row.last_active))),
    ];
    if (sessions.length) {
        lines.push("");
        lines.push(ansi.bold("Recent sessions"));
        lines.push(renderTable("", sessions.slice(0, 80).map((s) => [
            shortId(str(s.session_id)),
            str(s.provider) || "-",
            str(s.model) || "-",
            formatDate(str(s.modified_at)),
            truncate(str(s.first_prompt) || str(s.title), 44) || "-",
        ]), ["Session", "Agent", "Model", "Modified", "Prompt"], false, [15, 8, 18, 16, 46]));
    }
    return lines.join("\n");
}
function renderModelList(rows) {
    if (rows.length === 0)
        return ansi.yellow("No model configurations found.");
    const groups = new Map();
    for (const row of rows.map(asRecord)) {
        const agent = str(row.agent) || "other";
        const group = groups.get(agent) ?? [];
        group.push(row);
        groups.set(agent, group);
    }
    const order = ["claude", "codex", ...Array.from(groups.keys()).filter((key) => key !== "claude" && key !== "codex").sort()];
    const sections = [];
    for (const agent of order) {
        const group = groups.get(agent);
        if (!group?.length)
            continue;
        sections.push(ansi.bold(titleCase(agent)));
        sections.push(renderTable("", group.map((r) => [
            profileName(r),
            str(r.model) || "-",
            compactPath(str(r.auth), 34),
            compactPath(str(r.source), 30) || "-",
        ]), ["Name", "Model", "Auth", "Source"], false, [18, 24, 36, 32]));
    }
    return sections.join("\n\n");
}
function renderStatusList(rows) {
    if (rows.length === 0)
        return ansi.yellow("No cataloged sessions found.");
    return renderTable("Status", rows.map((row) => {
        const r = asRecord(row);
        return [
            compactPath(str(r.catalog), 22),
            shortId(str(r.session_id)),
            truncate(str(r.title), 46),
            str(r.status) || "unknown",
            formatDate(str(r.started_at)),
            formatDate(str(r.ended_at)),
            str(r.exit_code) || "-",
            str(r.pid) || "-",
        ];
    }), ["Catalog", "Session", "Title", "Status", "Started", "Ended", "Exit", "PID"], true, [22, 15, 48, 11, 16, 16, 6, 8]);
}
function renderRunList(rows) {
    if (rows.length === 0)
        return ansi.yellow("No runs recorded.");
    return renderTable("Runs", rows.map((row) => {
        const r = asRecord(row);
        return [
            shortId(str(r.run_id)),
            str(r.provider) || "-",
            str(r.status) || "-",
            formatDate(str(r.started_at)),
            formatDate(str(r.ended_at)),
            str(r.exit_code) || "-",
            str(r.pid) || "-",
            compactPath(str(r.project_path), 38),
        ];
    }), ["Run", "Agent", "Status", "Started", "Ended", "Exit", "PID", "Project"], true, [15, 8, 11, 16, 16, 6, 8, 40]);
}
function renderRunShow(row) {
    if (!row.run_id)
        return ansi.yellow("Run not found.");
    return [
        `${ansi.bold("Run:")} ${ansi.cyan(str(row.run_id))}`,
        detailLine("Agent", str(row.provider) || "-"),
        detailLine("Status", str(row.status) || "-"),
        detailLine("Started", formatDate(str(row.started_at))),
        detailLine("Ended", formatDate(str(row.ended_at))),
        detailLine("PID", str(row.pid) || "-"),
        detailLine("Exit", str(row.exit_code) || "-"),
        detailLine("Project", str(row.project_path) || "-"),
        detailLine("Session", str(row.session_id) || "-"),
    ].join("\n");
}
function renderMutationResult(row) {
    const ok = row.ok !== false;
    const prefix = ok ? ansi.green("ok") : ansi.red("error");
    const action = str(row.action);
    const message = str(row.message) || (ok ? "Done." : "Failed.");
    return `${ansi.bold(prefix)}${action ? ansi.dim(` ${action}`) : ""}  ${message}`;
}
function renderKeyValue(title, row) {
    const keys = Object.keys(row);
    if (keys.length === 0)
        return ansi.yellow(`${title}: empty`);
    const entries = title === "Starling config" ? configEntries(row) : keys.map((key) => [labelFor(key), formatValue(row[key])]);
    return [
        ansi.bold(title),
        ...entries.map(([key, value]) => detailLine(key, value)),
    ].join("\n");
}
function renderTable(title, rows, headers, includeTitle = true, widths) {
    const lines = [];
    if (includeTitle && title) {
        lines.push(ansi.bold(`${title} (${rows.length})`));
    }
    const cols = headers.map((header, index) => widths?.[index] ?? inferWidth(index, header, rows));
    lines.push(boxLine("┌", "┬", "┐", cols));
    lines.push(boxRow(headers.map((header) => ansi.cyan(header)), cols));
    lines.push(boxLine("├", "┼", "┤", cols));
    for (const row of rows) {
        lines.push(boxRow(row, cols));
    }
    lines.push(boxLine("└", "┴", "┘", cols));
    return lines.join("\n");
}
function detailLine(label, value, indent = 2) {
    return `${" ".repeat(indent)}${ansi.gray(`${label}:`)} ${value || "-"}`;
}
function boxLine(left, mid, right, widths) {
    return `${left}${widths.map((width) => "─".repeat(width + 2)).join(mid)}${right}`;
}
function boxRow(values, widths) {
    const cells = widths.map((width, index) => {
        const value = fitCell(values[index] ?? "-", width);
        return ` ${value}${" ".repeat(Math.max(0, width - visible(value)))} `;
    });
    return `│${cells.join("│")}│`;
}
function fitCell(value, width) {
    if (visible(value) <= width)
        return value || "-";
    return truncate(value, Math.max(1, width));
}
function inferWidth(index, header, rows) {
    const longest = Math.max(visible(header), ...rows.map((row) => visible(row[index] ?? "")));
    return Math.min(Math.max(longest, 6), 36);
}
function resolveCatalog(spaces, query) {
    return spaces.find((space) => str(space.id) === query)
        ?? spaces.find((space) => str(space.name) === query)
        ?? spaces.find((space) => catalogPath(space, spaces) === query);
}
function catalogPath(space, all) {
    const spaces = all.map(asRecord);
    const names = [str(space.name)];
    let parentId = typeof space.parent_id === "string" ? space.parent_id : "";
    const seen = new Set([str(space.id)]);
    while (parentId && !seen.has(parentId)) {
        const parent = spaces.find((candidate) => str(candidate.id) === parentId);
        if (!parent)
            break;
        names.unshift(str(parent.name));
        seen.add(parentId);
        parentId = typeof parent.parent_id === "string" ? parent.parent_id : "";
    }
    return names.filter(Boolean).join("/");
}
function parentName(space, all) {
    const parentId = typeof space.parent_id === "string" ? space.parent_id : "";
    if (!parentId)
        return "-";
    return str(all.find((candidate) => str(candidate.id) === parentId)?.name) || parentId;
}
function withJson(args) {
    return args.includes("--json") ? args : [...args, "--json"];
}
function withPins(args) {
    return args.includes("--pins") ? args : [...args, "--pins"];
}
function hasMachineOrHelpFlag(args) {
    return args.some((arg) => arg === "--json" || arg === "-h" || arg === "--help" || arg === "help");
}
function normalizeRoot(value) {
    if (value === "s" || value === "ses")
        return "session";
    if (value === "cat" || value === "space" || value === "sp")
        return "catalog";
    if (value === "prj")
        return "project";
    if (value === "models")
        return "model";
    return value;
}
function normalizeSub(value, fallback) {
    if (!value || value.startsWith("-"))
        return fallback;
    if (value === "ls")
        return "list";
    return value;
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function str(value) {
    if (value == null)
        return "";
    return String(value).replace(/\x1b\[[0-9;]*m/g, "").replace(/\[[0-9;]*m\]/g, "");
}
function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : str(value) || "-";
}
function formatValue(value) {
    if (Array.isArray(value))
        return value.join(", ");
    if (value && typeof value === "object")
        return JSON.stringify(value);
    return str(value) || "-";
}
function formatAgentModelSummary(value) {
    const row = asRecord(value);
    const entries = Object.entries(row).sort((a, b) => Number(b[1]) - Number(a[1]));
    const shown = entries.slice(0, 5).map(([key, count]) => `${key}(${count})`);
    if (entries.length > shown.length)
        shown.push(`+${entries.length - shown.length}`);
    return shown.join(", ");
}
function topCountKey(value) {
    const entries = Object.entries(asRecord(value)).sort((a, b) => Number(b[1]) - Number(a[1]));
    return entries.length ? entries[0][0] : "-";
}
function tagsText(value) {
    return Array.isArray(value) ? value.map(str).filter(Boolean).join(", ") : str(value);
}
function cacheTokens(usage) {
    const direct = Number(usage.cache_tokens ?? 0);
    const read = Number(usage.cache_read_input_tokens ?? 0);
    const created = Number(usage.cache_creation_input_tokens ?? 0);
    const total = direct + read + created;
    return Number.isFinite(total) && total > 0 ? total : 0;
}
function titleCase(value) {
    if (!value)
        return "-";
    return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
function profileName(row) {
    const name = str(row.name) || "-";
    const scope = str(row.scope);
    if (name === "current" && scope === "current")
        return "default";
    return name;
}
function labelFor(key) {
    return key
        .replace(/_/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\b\w/g, (char) => char.toUpperCase());
}
function configEntries(row) {
    return [
        ["Config", formatValue(row.configPath)],
        ["Home", formatValue(row.effectiveHomePath ?? row.configuredHomePath)],
        ["Source", formatValue(row.homeSource)],
        ["Store", formatValue(row.storePath)],
        ["Runs", formatValue(row.runsPath)],
        ["Claude settings", formatValue(row.settingsClaudePath)],
        ["Codex settings", formatValue(row.settingsCodexPath)],
    ];
}
function shortId(id) {
    return id.length > 13 ? id.slice(0, 13) : id || "-";
}
function canonicalSessionId(id) {
    const lower = String(id || "").trim().toLowerCase();
    const parts = lower.split("-");
    if (parts.length >= 5) {
        const candidate = parts.slice(-5).join("-");
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate)) {
            return candidate;
        }
    }
    return lower;
}
function compactPath(value, max) {
    if (value.length <= max)
        return value || "-";
    return `…${Array.from(value).slice(-Math.max(0, max - 1)).join("")}`;
}
function truncate(value, max) {
    const chars = Array.from(value || "");
    if (chars.length <= max)
        return value || "";
    return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}
function visible(value) {
    return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function formatDate(value) {
    if (!value)
        return "-";
    return value.slice(0, 16).replace("T", " ");
}
