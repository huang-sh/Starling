export interface StarlingScreenOptions {
  synchronizedOutput?: boolean;
}

const SYNC_BEGIN = "\u001b[?2026h";
const SYNC_END = "\u001b[?2026l";
const PAINT_BEGIN = "\u001b[?25l\u001b[?7l";
const PAINT_END = "\u001b[?7h";

/**
 * Normal-screen terminal painter with a cursor anchor at the frame's last row.
 * The first frame is appended directly to native scrollback. Later frames walk
 * back to their first row with relative cursor movement and repaint only rows
 * whose content changed. This keeps the shell's existing scrollback intact and
 * avoids depending on terminal geometry or an alternate-screen buffer.
 */
export class StarlingScreen {
  private previousLines: string[] | undefined;
  private readonly write: (value: string) => void;
  private readonly synchronizedOutput: boolean;

  constructor(
    write: (value: string) => void,
    options: StarlingScreenOptions = {},
  ) {
    this.write = write;
    this.synchronizedOutput = options.synchronizedOutput ?? shouldUseSynchronizedOutput();
  }

  paint(frame: string, force = false): boolean {
    const nextLines = frame.split("\n");
    const update = this.previousLines === undefined
      ? directFrameUpdate(nextLines)
      : relativeFrameUpdate(this.previousLines, nextLines, force);
    if (!update) {
      this.previousLines = nextLines;
      return false;
    }

    const syncBegin = this.synchronizedOutput ? SYNC_BEGIN : "";
    const syncEnd = this.synchronizedOutput ? SYNC_END : "";
    this.write(`${syncBegin}${PAINT_BEGIN}${update}${PAINT_END}${syncEnd}`);
    this.previousLines = nextLines;
    return true;
  }

  reset(): void {
    this.previousLines = undefined;
  }
}

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

function directFrameUpdate(lines: readonly string[]): string {
  return lines.join("\r\n");
}

function relativeFrameUpdate(
  previous: readonly string[],
  next: readonly string[],
  force: boolean,
): string {
  const changed = force
    || previous.length !== next.length
    || next.some((line, index) => previous[index] !== line);
  if (!changed) return "";

  const traversedRows = Math.max(previous.length, next.length);
  let output = previous.length > 1 ? `\r\u001b[${previous.length - 1}A` : "\r";
  for (let index = 0; index < traversedRows; index += 1) {
    if (index >= next.length) {
      output += "\r\u001b[2K\u001b[0m";
    } else if (force || previous[index] !== next[index]) {
      output += `\r\u001b[2K\u001b[0m${next[index]}`;
    }
    if (index < traversedRows - 1) output += "\r\n";
  }

  const removedRows = previous.length - next.length;
  if (removedRows > 0) output += `\r\u001b[${removedRows}A`;
  return output;
}
