import os from "node:os";
import { filterSlashCommands, type SlashCommandItem } from "./commands.js";
import type { ActivityEntry, StarlingTuiState, TimelineEntry } from "./state.js";

export interface StarlingTuiViewport {
  width: number;
  height: number;
  color?: boolean;
  /** Animation frame supplied by the terminal controller. */
  tick?: number;
}

export const STARLING_TUI_WIDE_MIN_COLUMNS = 100;

export interface RenderLine {
  text: string;
  tone?:
    | "brand"
    | "muted"
    | "thinking"
    | "user"
    | "userBlock"
    | "assistant"
    | "tool"
    | "toolActive"
    | "toolError"
    | "active"
    | "success"
    | "error";
}

/**
 * Render the visible Starling component flow without cursor controls.
 *
 * The frame is intentionally intrinsic-height. The terminal painter keeps it
 * anchored in the normal screen buffer, so a short conversation stays near
 * the prompt instead of being stretched into a full-screen dashboard.
 */
export function renderStarlingFrame(
  state: StarlingTuiState,
  viewport: StarlingTuiViewport,
): string {
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  const tick = Math.max(0, Math.floor(viewport.tick ?? 0));
  if (width < 20 || height < 10) {
    return renderCompactFrame(state, width, height, tick, viewport.color === true);
  }

  const footer = renderFooter(state, width, tick);
  const transcript = state.timeline.length === 0
    ? renderEmptyWorkspace(state, width)
    : renderTranscriptLines(state, width);
  const bodySource = state.timeline.length === 0 && state.activity.length > 0
    ? [...transcript, { text: "" }, ...renderActivityLines(state.activity, width)]
    : transcript;
  const separator: RenderLine[] = bodySource.length > 0 && footer.length > 0 ? [{ text: "" }] : [];
  const bodyHeight = Math.max(0, height - footer.length - separator.length);
  const body = takeViewport(bodySource, bodyHeight, state.scrollOffset);
  const lines = body.length === 0
    ? footer.slice(-height)
    : [...body, ...separator, ...footer].slice(-height);

  return lines
    .map((line) => colorize(fitTerminalLine(line.text, width), line.tone, viewport.color === true))
    .join("\n");
}

export function renderTimelineLines(state: StarlingTuiState, width: number): RenderLine[] {
  const contentWidth = Math.max(10, width);
  if (state.timeline.length === 0) return [];

  const lines: RenderLine[] = [];
  for (const entry of state.timeline) {
    if (lines.length > 0) lines.push({ text: "" });
    lines.push(...renderTimelineEntry(entry, contentWidth));
  }
  return lines;
}

export function renderActivityLines(activity: readonly ActivityEntry[], width: number): RenderLine[] {
  const lines: RenderLine[] = [];
  if (activity.length === 0) return lines;
  for (const item of activity.slice(-8)) {
    const tone = activityTone(item);
    const prefix = `  ${activityGlyph(item)} ${item.label} · `;
    const details = wrapTerminalText(item.detail, Math.max(4, width - visibleWidth(prefix)));
    lines.push({ text: `${prefix}${details[0] ?? ""}`, tone });
    for (const detail of details.slice(1, 2)) {
      lines.push({ text: `${" ".repeat(visibleWidth(prefix))}${detail}`, tone: "muted" });
    }
  }
  return lines;
}

/** Render timeline entries and runtime activity in one chronological transcript. */
export function renderTranscriptLines(state: StarlingTuiState, width: number): RenderLine[] {
  const contentWidth = Math.max(10, width);
  if (state.timeline.length === 0) {
    return renderActivityLines(state.activity, contentWidth);
  }

  const records: Array<
    | { id: number; kind: "timeline"; value: TimelineEntry }
    | { id: number; kind: "activity"; value: ActivityEntry }
  > = [
    ...state.timeline.map((value) => ({ id: value.id, kind: "timeline" as const, value })),
    ...state.activity.map((value) => ({ id: value.id, kind: "activity" as const, value })),
  ].sort((left, right) => left.id - right.id);

  const lines: RenderLine[] = [];
  for (const record of records) {
    if (lines.length > 0) lines.push({ text: "" });
    if (record.kind === "activity") {
      lines.push(...renderActivityLines([record.value], contentWidth));
      continue;
    }
    lines.push(...renderTimelineEntry(record.value, contentWidth));
  }
  return lines;
}

/** Sanitize untrusted content before it reaches a terminal render path. */
export function sanitizeTerminalText(value: string, preserveNewlines = true): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      index = skipEscSequence(value, index);
      continue;
    }
    if (code === 0x9b) {
      index = skipCsi(value, index + 1);
      continue;
    }
    if (code === 0x9d) {
      index = skipControlString(value, index + 1, true);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = skipControlString(value, index + 1, false);
      continue;
    }
    if (code === 0x0d) {
      if (preserveNewlines) output += "\n";
      if (value.charCodeAt(index + 1) === 0x0a) index += 1;
      index += 1;
      continue;
    }
    if (code === 0x0a) {
      if (preserveNewlines) output += "\n";
      index += 1;
      continue;
    }
    if (code === 0x09) {
      output += "  ";
      index += 1;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }
    const point = value.codePointAt(index);
    if (point === undefined) break;
    output += String.fromCodePoint(point);
    index += point > 0xffff ? 2 : 1;
  }
  return output.normalize("NFC");
}

export function wrapTerminalText(value: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const logicalLines = sanitizeTerminalText(value).split("\n");
  const output: string[] = [];
  for (const logical of logicalLines) {
    if (!logical) {
      output.push("");
      continue;
    }
    let remaining = logical;
    while (visibleWidth(remaining) > limit) {
      const slice = takeTerminalColumns(remaining, limit);
      if (!slice) break;
      let splitAt = slice.length;
      const whitespace = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("/"));
      if (whitespace >= Math.floor(slice.length * 0.55)) splitAt = whitespace + 1;
      const line = remaining.slice(0, splitAt).trimEnd();
      output.push(line || slice);
      remaining = remaining.slice(splitAt).trimStart();
    }
    output.push(remaining);
  }
  return output.length > 0 ? output : [""];
}

export function fitTerminalLine(value: string, width: number): string {
  const limit = Math.max(0, Math.floor(width));
  const clipped = takeTerminalColumns(sanitizeTerminalText(value, false), limit);
  return clipped + " ".repeat(Math.max(0, limit - visibleWidth(clipped)));
}

export function visibleWidth(value: string): number {
  let width = 0;
  for (const cluster of graphemes(stripAnsi(value))) {
    width += graphemeWidth(cluster);
  }
  return width;
}

function renderCompactFrame(
  state: StarlingTuiState,
  width: number,
  height: number,
  tick: number,
  color: boolean,
): string {
  const lines: RenderLine[] = [];
  if (height >= 3 && state.timeline.length === 0) {
    lines.push({ text: "✦ STARLING", tone: "brand" });
  }
  if (state.busy || state.compacting || state.phase === "starting" || state.phase === "error") {
    lines.push({
      text: `${state.busy || state.compacting ? spinner(tick) : phaseGlyph(state, tick)} ${state.status}`,
      tone: state.phase === "error" ? "error" : state.busy || state.compacting ? "active" : "muted",
    });
  }
  if (state.slashMenuOpen) {
    const commands = filterSlashCommands(state.composer, state.slashCommands);
    const selected = commands[state.slashSelected];
    if (selected) {
      lines.push({ text: `› /${selected.name}  ${selected.description}`, tone: "active" });
    } else {
      lines.push({ text: "× No matching slash commands", tone: "muted" });
    }
  }
  const compactInput = wrapEditorLines(
    state.composer,
    state.composerCursor,
    Math.max(1, width - 2),
    1,
  ).at(-1)?.text ?? "▏";
  lines.push({
    text: `› ${compactInput}`,
    tone: state.composer ? "user" : "brand",
  });
  return lines.slice(-height)
    .map((line) => colorize(fitTerminalLine(line.text, width), line.tone, color))
    .join("\n");
}

function renderEmptyWorkspace(state: StarlingTuiState, width: number): RenderLine[] {
  const panelWidth = Math.min(100, Math.max(4, width - 2));
  const indent = " ".repeat(Math.max(0, Math.floor((width - panelWidth) / 2)));
  const innerWidth = Math.max(1, panelWidth - 2);
  const session = state.sessionName || shorten(state.sessionId || "new session", 28);
  const model = shorten(state.model || "default model", 30);
  const thinking = state.thinking ? `thinking ${state.thinking}` : "thinking default";
  const path = displayPath(state.cwd, Math.max(8, innerWidth - 4));

  if (panelWidth < 66) {
    const contentWidth = Math.max(1, innerWidth - 4);
    const rows: Array<{ text: string; tone: RenderLine["tone"] }> = [
      { text: "✦  STARLING", tone: "brand" },
      { text: "Pi SDK agent workspace", tone: "assistant" },
      { text: path, tone: "muted" },
      { text: `${model} · ${thinking}`, tone: "muted" },
      { text: `session ${session}`, tone: "muted" },
      { text: "Enter send · Alt+Enter newline · Esc interrupt", tone: "muted" },
    ];
    return [
      { text: `${indent}╭${"─".repeat(innerWidth)}╮`, tone: "muted" },
      ...rows.map((row) => ({
        text: `${indent}│  ${fitTerminalLine(row.text, contentWidth)}  │`,
        tone: row.tone,
      })),
      { text: `${indent}╰${"─".repeat(innerWidth)}╯`, tone: "muted" },
    ];
  }

  const leftWidth = Math.max(24, Math.floor((innerWidth - 1) * 0.48));
  const rightWidth = innerWidth - leftWidth - 1;
  const row = (left: string, right: string, tone: RenderLine["tone"]): RenderLine => ({
    text: `${indent}│${fitTerminalLine(`  ${left}`, leftWidth)}│${fitTerminalLine(`  ${right}`, rightWidth)}│`,
    tone,
  });
  return [
    { text: `${indent}╭${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}╮`, tone: "muted" },
    row("✦  STARLING", "KEYBOARD", "brand"),
    row("Pi SDK agent workspace", "Enter      send", "assistant"),
    row(model, "Alt+Enter  newline", "muted"),
    row(thinking, "Esc        interrupt", "muted"),
    row(`session ${session}`, "Ctrl+C     exit", "muted"),
    { text: `${indent}├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`, tone: "muted" },
    { text: `${indent}│  ${fitTerminalLine(path, Math.max(1, innerWidth - 4))}  │`, tone: "muted" },
    { text: `${indent}╰${"─".repeat(innerWidth)}╯`, tone: "muted" },
  ];
}

function renderFooter(state: StarlingTuiState, width: number, tick: number): RenderLine[] {
  if (state.uiPrompt) return renderInteraction(state, width, tick);

  const rows: RenderLine[] = [];
  if (state.compacting) {
    rows.push({ text: `  ${spinner(tick)} Compacting context…  (esc to cancel)`, tone: "active" });
  } else if (state.busy) {
    const queue = state.queueDepth > 0 ? ` · ${state.queueDepth} queued` : "";
    rows.push({ text: `  ${spinner(tick)} Working…${queue}  (esc to interrupt)`, tone: "active" });
  } else if (state.phase === "starting") {
    rows.push({ text: `  ${phaseGlyph(state, tick)} ${state.status}`, tone: "muted" });
  } else if (state.phase === "error") {
    rows.push({ text: `  × ${state.status}`, tone: "error" });
  } else if (state.scrollOffset > 0) {
    rows.push({ text: `  ↑ ${state.scrollOffset} lines back · PgDn return`, tone: "muted" });
  }

  rows.push(...renderExtensionStatus(state, width));
  rows.push(...renderExtensionWidgets(state, "aboveEditor", width));
  if (state.slashMenuOpen) rows.push(...renderSlashMenu(state, width));

  const meta = editorMeta(state, width);
  const editorWidth = Math.max(1, width - 6);
  const visibleInput = wrapEditorLines(state.composer, state.composerCursor, editorWidth, 5);
  rows.push({ text: boxRule("╭─ ", `${meta} `, "╮", width), tone: "brand" });
  for (const line of visibleInput.slice(0, -1)) {
    rows.push({ text: boxContent(`· ${line.text}`, width), tone: "user" });
  }
  rows.push({
    text: editorBottomLine(visibleInput.at(-1)?.text ?? "▏", width),
    tone: state.phase === "error" ? "error" : "brand",
  });
  rows.push(...renderExtensionWidgets(state, "belowEditor", width));
  return rows;
}

function renderExtensionStatus(state: StarlingTuiState, width: number): RenderLine[] {
  const rows: RenderLine[] = [];
  for (const [key, value] of Object.entries(state.statusItems)) {
    const prefix = `  ${key} · `;
    const lines = wrapTerminalText(value, Math.max(1, width - visibleWidth(prefix)));
    rows.push({ text: `${prefix}${lines[0] ?? ""}`, tone: "active" });
    for (const line of lines.slice(1)) {
      rows.push({ text: `${" ".repeat(visibleWidth(prefix))}${line}`, tone: "muted" });
    }
  }
  return rows;
}

function renderExtensionWidgets(
  state: StarlingTuiState,
  placement: "aboveEditor" | "belowEditor",
  width: number,
): RenderLine[] {
  const rows: RenderLine[] = [];
  for (const widget of Object.values(state.widgets)) {
    if (widget.placement !== placement) continue;
    const prefix = `  ${widget.key} · `;
    widget.lines.forEach((value, lineIndex) => {
      const linePrefix = lineIndex === 0 ? prefix : " ".repeat(visibleWidth(prefix));
      const lines = wrapTerminalText(value, Math.max(1, width - visibleWidth(linePrefix)));
      rows.push({ text: `${linePrefix}${lines[0] ?? ""}`, tone: "muted" });
      for (const line of lines.slice(1)) {
        rows.push({ text: `${" ".repeat(visibleWidth(linePrefix))}${line}`, tone: "muted" });
      }
    });
  }
  return rows;
}

function renderSlashMenu(state: StarlingTuiState, width: number): RenderLine[] {
  const matches = filterSlashCommands(state.composer, state.slashCommands);
  if (matches.length === 0) {
    return [
      { text: "  × No matching slash commands", tone: "muted" },
      { text: "  Enter show error · Esc close", tone: "muted" },
    ];
  }

  const limit = Math.min(8, matches.length);
  const selected = Math.min(state.slashSelected, matches.length - 1);
  const start = Math.max(0, Math.min(
    selected - Math.floor(limit / 2),
    matches.length - limit,
  ));
  const visible = matches.slice(start, start + limit);
  const compact = width < 58;
  const rows = visible.map((command, index) => {
    const absoluteIndex = start + index;
    const marker = absoluteIndex === selected ? "›" : " ";
    const name = slashDisplayName(command);
    const source = command.source === "starling" ? "" : ` [${command.source}]`;
    const text = compact
      ? `  ${marker} ${name}${source}`
      : `  ${marker} ${name.padEnd(28)} ${command.description}${source}`;
    return {
      text,
      tone: absoluteIndex === selected ? "active" as const : "muted" as const,
    };
  });
  if (matches.length > visible.length) {
    rows.push({
      text: `  ${start + 1}–${start + visible.length} of ${matches.length} commands`,
      tone: "muted",
    });
  }
  rows.push({ text: "  ↑/↓ select · Tab/Enter complete · Esc close", tone: "muted" });
  return rows;
}

function slashDisplayName(command: SlashCommandItem): string {
  return `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
}

function renderInteraction(state: StarlingTuiState, width: number, tick: number): RenderLine[] {
  const prompt = state.uiPrompt!;
  const title = prompt.method === "confirm" ? "PERMISSION REQUIRED" : prompt.title;
  const rows: RenderLine[] = [{ text: boxRule("╭─ ", title, " ╮", width), tone: "active" }];
  for (const line of wrapTerminalText(prompt.message || prompt.title, Math.max(4, width - 4)).slice(0, 2)) {
    rows.push({ text: boxContent(line, width), tone: "assistant" });
  }
  if (prompt.method === "confirm" || prompt.method === "select") {
    const choices = prompt.options.length > 0
      ? prompt.options.map((option, index) => index === prompt.selected ? `[${option}]` : ` ${option} `).join("  ")
      : "No options supplied";
    rows.push({ text: boxContent(choices, width), tone: "user" });
  } else {
    const inputLines = wrapEditorLines(
      prompt.value,
      prompt.cursor ?? prompt.value.length,
      Math.max(1, width - 6),
      5,
    );
    inputLines.forEach((line) => {
      const marker = line.hasCursor ? "›" : "·";
      rows.push({
        text: boxContent(`${marker} ${line.text}`, width),
        tone: prompt.value ? "user" : "muted",
      });
    });
  }
  rows.push({ text: boxRule("╰─ ", `${spinner(tick)} ${state.status}`, " ╯", width), tone: "active" });
  rows.push({
    text: prompt.method === "confirm"
      ? "  Y allow · N deny · ←/→ choose · Enter confirm · Esc deny"
      : prompt.method === "select"
        ? "  ↑/↓ choose · Enter select · Esc cancel"
        : prompt.method === "editor"
          ? "  Enter newline · Ctrl+S submit · Esc cancel"
          : "  Enter submit · Esc cancel",
    tone: "muted",
  });
  return rows;
}

function renderTimelineEntry(entry: TimelineEntry, width: number): RenderLine[] {
  if (entry.kind === "user") {
    return wrapTerminalText(entry.text, Math.max(1, width - 4)).map((text) => ({
      text: `  ${text}`,
      tone: "userBlock" as const,
    }));
  }
  if (entry.kind === "assistant") {
    const output: RenderLine[] = [];
    if (entry.thinking) {
      const thinking = wrapTerminalText(entry.thinking, Math.max(1, width - 4));
      for (const text of thinking) output.push({ text: `  ${text}`, tone: "thinking" });
    }
    const body = entry.text || (entry.pending ? "…" : "");
    if (entry.thinking && body) output.push({ text: "" });
    if (body) {
      output.push(...wrapTerminalText(body, Math.max(1, width - 4)).map((text) => ({
        text: `  ${text}`,
        tone: "assistant" as const,
      })));
    }
    return output;
  }
  if (entry.kind === "tool") {
    const glyph = entry.toolState === "error" ? "×" : entry.toolState === "done" ? "✓" : "◆";
    const tone: RenderLine["tone"] = entry.toolState === "error"
      ? "toolError"
      : entry.toolState === "done" ? "tool" : "toolActive";
    const body = wrapTerminalText(entry.text || "Waiting for output…", Math.max(1, width - 6)).slice(0, 6);
    return [
      { text: `  ${glyph} ${entry.toolName || "tool"}`, tone },
      ...body.map((text) => ({ text: `    ${text}`, tone })),
    ];
  }
  const tone = entry.kind === "error" ? "error" : "muted";
  return wrapTerminalText(entry.text, Math.max(1, width - 4)).map((text, index) => ({
    text: index === 0 ? `  ${entry.kind === "error" ? "×" : "·"} ${text}` : `    ${text}`,
    tone,
  }));
}

function takeViewport(lines: RenderLine[], height: number, scrollOffset: number): RenderLine[] {
  if (height <= 0) return [];
  const end = Math.max(0, lines.length - Math.max(0, scrollOffset));
  const start = Math.max(0, end - height);
  return lines.slice(start, end);
}

function phaseGlyph(state: StarlingTuiState, tick: number): string {
  if (state.phase === "error") return "×";
  if (state.busy || state.compacting) return spinner(tick);
  if (state.ready) return "●";
  return "○";
}

function spinner(tick: number): string {
  return ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][tick % 10];
}

function activityGlyph(item: ActivityEntry): string {
  if (item.tone === "error") return "×";
  if (item.tone === "success") return "✓";
  if (item.tone === "active") return "◆";
  return "·";
}

function activityTone(item: ActivityEntry): RenderLine["tone"] {
  if (item.tone === "active") return "active";
  if (item.tone === "success") return "success";
  if (item.tone === "error") return "error";
  return "muted";
}

function editorMeta(state: StarlingTuiState, width: number): string {
  const session = state.sessionName || shorten(state.sessionId || "new session", 20);
  const pathWidth = Math.max(8, Math.min(34, Math.floor(width * 0.3)));
  return [
    shorten(state.model || "default model", 28),
    state.thinking ? `thinking ${shorten(state.thinking, 12)}` : "",
    displayPath(state.cwd, pathWidth),
    session,
  ].filter(Boolean).join(" · ");
}

function editorBottomLine(value: string, width: number): string {
  const left = "╰─ › ";
  const right = "╯";
  const textWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
  const text = takeTerminalColumns(sanitizeTerminalText(value, false), textWidth);
  const fill = Math.max(
    0,
    width - visibleWidth(left) - visibleWidth(text) - visibleWidth(right),
  );
  return `${left}${text}${"─".repeat(fill)}${right}`;
}

interface EditorVisualLine {
  text: string;
  hasCursor: boolean;
}

/** Wrap an editor value while keeping the fake cursor inside the visible window. */
function wrapEditorLines(
  value: string,
  cursor: number | undefined,
  width: number,
  maxLines: number,
): EditorVisualLine[] {
  const at = editorCursorBoundary(value, cursor ?? value.length);
  const cleanValue = sanitizeTerminalText(value);
  const cleanCursor = Math.min(
    cleanValue.length,
    sanitizeTerminalText(value.slice(0, at)).length,
  );
  const marker = editorCursorMarker(cleanValue);
  const wrapped = wrapTerminalText(
    `${cleanValue.slice(0, cleanCursor)}${marker}${cleanValue.slice(cleanCursor)}`,
    width,
  );
  const cursorLine = Math.max(0, wrapped.findIndex((line) => line.includes(marker)));
  const lines = wrapped.map((line) => ({
    text: line.replace(marker, "▏"),
    hasCursor: line.includes(marker),
  }));
  const limit = Math.max(1, maxLines);
  if (lines.length <= limit) return lines;
  const maximumStart = lines.length - limit;
  const start = Math.min(maximumStart, Math.max(0, cursorLine - limit + 1));
  return lines.slice(start, start + limit);
}

function editorCursorBoundary(value: string, cursor: number): number {
  const bounded = Math.min(Math.max(0, Math.trunc(cursor)), value.length);
  let boundary = 0;
  for (const part of graphemeSegmenter.segment(value)) {
    if (part.index > bounded) break;
    boundary = part.index;
    if (part.index + part.segment.length <= bounded) boundary = part.index + part.segment.length;
  }
  return boundary;
}

function editorCursorMarker(value: string): string {
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const marker = String.fromCodePoint(codePoint);
    if (!value.includes(marker)) return marker;
  }
  return "\ufffc";
}

function boxRule(left: string, label: string, right: string, width: number): string {
  const cleanLabel = shorten(sanitizeTerminalText(label, false), Math.max(1, width - 6));
  const prefix = `${left}${cleanLabel}`;
  const fill = Math.max(0, width - visibleWidth(prefix) - visibleWidth(right));
  return `${prefix}${"─".repeat(fill)}${right}`;
}

function boxContent(value: string, width: number): string {
  const innerWidth = Math.max(0, width - 4);
  const content = fitTerminalLine(value, innerWidth);
  return `│ ${content} │`;
}

function displayPath(value: string, width: number): string {
  const home = os.homedir();
  const compact = value === home
    ? "~"
    : value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
  return shorten(compact, width);
}

function shorten(value: string, width: number): string {
  const clean = sanitizeTerminalText(value, false);
  if (visibleWidth(clean) <= width) return clean;
  if (width <= 1) return "…";
  return `${takeTerminalColumns(clean, width - 1)}…`;
}

function takeTerminalColumns(value: string, width: number): string {
  let result = "";
  let used = 0;
  for (const character of graphemes(value)) {
    const next = graphemeWidth(character);
    if (used + next > width) break;
    result += character;
    used += next;
  }
  return result;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

function graphemeWidth(value: string): number {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value)
    || value.includes("\ufe0f")
    || value.includes("\u20e3")) return 2;
  let width = 0;
  for (const character of Array.from(value)) {
    width = Math.max(width, codePointWidth(character.codePointAt(0) ?? 0));
  }
  return width;
}

function skipEscSequence(value: string, start: number): number {
  const introducer = value.charCodeAt(start + 1);
  if (Number.isNaN(introducer)) return value.length;
  if (introducer === 0x5b) return skipCsi(value, start + 2);
  if (introducer === 0x5d) return skipControlString(value, start + 2, true);
  if (introducer === 0x50 || introducer === 0x58 || introducer === 0x5e || introducer === 0x5f) {
    return skipControlString(value, start + 2, false);
  }
  return Math.min(value.length, start + 2);
}

function skipCsi(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return value.length;
}

function skipControlString(value: string, start: number, bellTerminates: boolean): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (bellTerminates && code === 0x07) return index + 1;
    if (code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return value.length;
}

function codePointWidth(codePoint: number): number {
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) return 0;
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f
      || codePoint === 0x2329
      || codePoint === 0x232a
      || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
      || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
      || (codePoint >= 0xff00 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
      || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) return 2;
  return 1;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function colorize(value: string, tone: RenderLine["tone"], enabled: boolean): string {
  if (!enabled || !tone) return value;
  const code = tone === "brand"
    ? "1;36"
    : tone === "muted"
      ? "2;37"
      : tone === "thinking"
        ? "2;3;37"
        : tone === "userBlock"
          ? "38;5;255;48;5;236"
          : tone === "tool"
            ? "38;5;252;48;5;237"
            : tone === "toolActive"
              ? "38;5;229;48;5;237"
              : tone === "toolError"
                ? "38;5;210;48;5;237"
      : tone === "user"
        ? "1;34"
        : tone === "active"
          ? "1;33"
          : tone === "success"
            ? "1;32"
            : tone === "error"
              ? "1;31"
              : "0;37";
  return `\u001b[${code}m${value}\u001b[0m`;
}
