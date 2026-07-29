import type { StarlingFrameParts } from "./render.js";

export interface StarlingScreenOptions {
  synchronizedOutput?: boolean;
}

export interface StarlingScreenViewport {
  height: number;
  force?: boolean;
}

const SYNC_BEGIN = "\u001b[?2026h";
const SYNC_END = "\u001b[?2026l";

/**
 * Inline terminal painter modelled on pi's `doRender`: content lives in the
 * terminal's main screen buffer (never an alternate screen), the first frame
 * paints straight down from the shell prompt, and once the transcript grows
 * past the viewport the overflow scrolls into native scrollback via repeated
 * CR/LF. Correctness rests on tracking rows as *logical* line numbers
 * (`previousViewportTop`, `hardwareCursorRow`) rather than physical screen
 * rows: every emitted scroll is paired with `prevViewportTop += scroll` so the
 * logical-to-screen mapping used by the differential repaint stays exact.
 */
export class StarlingScreen {
  private previousLines: string[] = [];
  private previousViewportTop = 0;
  private hardwareCursorRow = 0;
  private cursorRow = 0;
  private maxLinesRendered = 0;
  private previousHeight = 0;
  private lastMode: "none" | "normal" | "overlay" = "none";
  private readonly write: (value: string) => void;
  private readonly synchronizedOutput: boolean;

  constructor(
    write: (value: string) => void,
    options: StarlingScreenOptions = {},
  ) {
    this.write = write;
    this.synchronizedOutput = options.synchronizedOutput ?? shouldUseSynchronizedOutput();
  }

  paint(parts: StarlingFrameParts, viewport: StarlingScreenViewport): boolean {
    const height = Math.max(1, Math.floor(viewport.height));
    if (parts.mode === "overlay" || parts.mode === "compact") {
      return this.paintOverlay(parts.live, height);
    }
    return this.doRender(parts, height, viewport.force === true);
  }

  /**
   * Leave the inline workspace: drop the cursor onto the first line after the
   * rendered content (scrolling once if it already fills the viewport) and
   * restore cursor visibility + bracketed-paste mode for the shell prompt.
   */
  reset(): void {
    let buffer = "";
    if (this.lastMode === "overlay") {
      buffer += "\x1b[H\x1b[0m\x1b[2J";
    } else if (this.previousLines.length > 0) {
      buffer += moveLines(this.cursorRow - this.hardwareCursorRow);
    }
    buffer += "\x1b[?2004l\x1b[?25h\r\n";
    this.write(buffer);
    this.previousLines = [];
    this.previousViewportTop = 0;
    this.hardwareCursorRow = 0;
    this.cursorRow = 0;
    this.maxLinesRendered = 0;
    this.previousHeight = 0;
    this.lastMode = "none";
  }

  /** Full-screen takeover for a modal picker or a tiny terminal. */
  private paintOverlay(live: readonly string[], height: number): boolean {
    const rows = live.slice(-height);
    let buffer = this.synchronizedOutput ? SYNC_BEGIN : "";
    buffer += "\x1b[H\x1b[0m\x1b[2J";
    buffer += rows.join("\r\n");
    buffer += this.synchronizedOutput ? SYNC_END : "";
    this.write(buffer);
    this.previousLines = [];
    this.previousHeight = height;
    this.lastMode = "overlay";
    return true;
  }

  /**
   * Differential inline paint (pi's doRender, minus kitty-image / termux /
   * debug paths). Returns false when nothing changed and nothing was written.
   */
  private doRender(parts: StarlingFrameParts, height: number, force: boolean): boolean {
    const newLines = [...parts.committed, ...parts.live];
    const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;

    // Overlay handoff or resize: clear and repaint the whole frame.
    if (this.lastMode === "overlay" || heightChanged) {
      this.fullRender(true, newLines, height);
      return true;
    }
    // First frame: paint straight down from the cursor without clearing.
    if (this.previousLines.length === 0) {
      this.fullRender(false, newLines, height);
      return true;
    }

    const previousBufferLength = this.previousViewportTop + this.previousHeight;
    let prevViewportTop = heightChanged
      ? Math.max(0, previousBufferLength - height)
      : this.previousViewportTop;
    let viewportTop = prevViewportTop;
    let hardwareCursorRow = this.hardwareCursorRow;
    const computeLineDiff = (targetRow: number): number =>
      (targetRow - viewportTop) - (hardwareCursorRow - prevViewportTop);

    // Find the first and last changed rows.
    let firstChanged = -1;
    let lastChanged = -1;
    const maxRows = Math.max(newLines.length, this.previousLines.length);
    for (let i = 0; i < maxRows; i += 1) {
      const oldLine = i < this.previousLines.length ? this.previousLines[i]! : "";
      const newLine = i < newLines.length ? newLines[i]! : "";
      if (oldLine !== newLine) {
        if (firstChanged === -1) firstChanged = i;
        lastChanged = i;
      }
    }
    const appendedLines = newLines.length > this.previousLines.length;
    if (appendedLines) {
      if (firstChanged === -1) firstChanged = this.previousLines.length;
      lastChanged = newLines.length - 1;
    }
    const appendStart = appendedLines
      && firstChanged === this.previousLines.length
      && firstChanged > 0;

    if (firstChanged === -1 && force) {
      firstChanged = 0;
      lastChanged = Math.max(0, newLines.length - 1);
    }

    // Nothing to do.
    if (firstChanged === -1) {
      this.previousViewportTop = prevViewportTop;
      this.previousHeight = height;
      this.lastMode = "normal";
      return false;
    }

    // All changes are in rows that disappeared (content shrank): clear the tail.
    if (firstChanged >= newLines.length) {
      if (this.previousLines.length > newLines.length) {
        const targetRow = Math.max(0, newLines.length - 1);
        if (targetRow < prevViewportTop) {
          this.fullRender(true, newLines, height);
          return true;
        }
        let buffer = this.synchronizedOutput ? SYNC_BEGIN : "";
        buffer += moveLines(computeLineDiff(targetRow));
        buffer += "\r";
        const extraLines = this.previousLines.length - newLines.length;
        if (extraLines > height) {
          this.fullRender(true, newLines, height);
          return true;
        }
        const clearStartOffset = newLines.length === 0 ? 0 : 1;
        if (extraLines > 0 && clearStartOffset > 0) {
          buffer += `\x1b[${clearStartOffset}B`;
        }
        for (let i = 0; i < extraLines; i += 1) {
          buffer += "\r\x1b[2K";
          if (i < extraLines - 1) buffer += "\x1b[1B";
        }
        const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
        if (moveBack > 0) buffer += `\x1b[${moveBack}A`;
        buffer += this.synchronizedOutput ? SYNC_END : "";
        this.write(buffer);
        this.cursorRow = targetRow;
        this.hardwareCursorRow = targetRow;
      }
      this.previousLines = newLines;
      this.previousViewportTop = prevViewportTop;
      this.previousHeight = height;
      this.lastMode = "normal";
      return true;
    }

    // The first change is above the viewport (already in scrollback): repaint.
    if (firstChanged < prevViewportTop) {
      this.fullRender(true, newLines, height);
      return true;
    }

    // Scroll the viewport down to reveal the changed rows, then repaint them.
    let buffer = this.synchronizedOutput ? SYNC_BEGIN : "";
    const prevViewportBottom = prevViewportTop + height - 1;
    const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
    if (moveTargetRow > prevViewportBottom) {
      const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
      const moveToBottom = height - 1 - currentScreenRow;
      if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
      const scroll = moveTargetRow - prevViewportBottom;
      buffer += "\r\n".repeat(scroll);
      prevViewportTop += scroll;
      viewportTop += scroll;
      hardwareCursorRow = moveTargetRow;
    }

    buffer += moveLines(computeLineDiff(moveTargetRow));
    buffer += appendStart ? "\r\n" : "\r";

    const renderEnd = Math.min(lastChanged, newLines.length - 1);
    for (let i = firstChanged; i <= renderEnd; i += 1) {
      if (i > firstChanged) buffer += "\r\n";
      buffer += `\x1b[2K${newLines[i]}`;
    }
    let finalCursorRow = renderEnd;

    // If the frame shrank, clear the now-empty tail rows and step back up.
    if (this.previousLines.length > newLines.length) {
      if (renderEnd < newLines.length - 1) {
        const moveDown = newLines.length - 1 - renderEnd;
        buffer += `\x1b[${moveDown}B`;
        finalCursorRow = newLines.length - 1;
      }
      const extraLines = this.previousLines.length - newLines.length;
      for (let i = newLines.length; i < this.previousLines.length; i += 1) {
        buffer += "\r\n\x1b[2K";
      }
      buffer += `\x1b[${extraLines}A`;
    }

    buffer += this.synchronizedOutput ? SYNC_END : "";
    this.write(buffer);

    this.cursorRow = Math.max(0, newLines.length - 1);
    this.hardwareCursorRow = finalCursorRow;
    this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
    this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);
    this.previousLines = newLines;
    this.previousHeight = height;
    this.lastMode = "normal";
    return true;
  }

  /** Repaint the whole frame at once; `clear` also wipes screen + scrollback. */
  private fullRender(clear: boolean, newLines: readonly string[], height: number): void {
    let buffer = this.synchronizedOutput ? SYNC_BEGIN : "";
    if (clear) buffer += "\x1b[2J\x1b[H\x1b[3J";
    for (let i = 0; i < newLines.length; i += 1) {
      if (i > 0) buffer += "\r\n";
      buffer += newLines[i];
    }
    buffer += this.synchronizedOutput ? SYNC_END : "";
    this.write(buffer);

    this.cursorRow = Math.max(0, newLines.length - 1);
    this.hardwareCursorRow = this.cursorRow;
    this.maxLinesRendered = clear ? newLines.length : Math.max(this.maxLinesRendered, newLines.length);
    const bufferLength = Math.max(height, newLines.length);
    this.previousViewportTop = Math.max(0, bufferLength - height);
    this.previousLines = [...newLines];
    this.previousHeight = height;
    this.lastMode = "normal";
  }
}

/**
 * Pick the terminal capability for synchronized output (DEC mode 2026) from the
 * environment, with an explicit override. Synchronized output is disabled under
 * tmux/screen, which multiplex their own buffers.
 */
export function shouldUseSynchronizedOutput(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicit = environment.STARLING_TUI_SYNC_OUTPUT?.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(explicit ?? "")) return false;
  if (["1", "true", "yes", "on"].includes(explicit ?? "")) return true;
  if (environment.TMUX || environment.STY || environment.TERM === "screen") return false;

  const terminal = [
    environment.TERM_PROGRAM,
    environment.LC_TERMINAL,
    environment.TERMINAL_EMULATOR,
  ].filter(Boolean).join(" ").toLowerCase();
  return Boolean(
    environment.WT_SESSION
      || environment.KITTY_WINDOW_ID
      || environment.WEZTERM_PANE
      || environment.GHOSTTY_RESOURCES_DIR
      || environment.VSCODE_PID
      || /wezterm|iterm|ghostty|kitty|alacritty|vscode/.test(terminal),
  );
}

/** Relative cursor move by `diff` screen rows (negative = up). */
function moveLines(diff: number): string {
  if (diff > 0) return `\x1b[${diff}B`;
  if (diff < 0) return `\x1b[${-diff}A`;
  return "";
}
