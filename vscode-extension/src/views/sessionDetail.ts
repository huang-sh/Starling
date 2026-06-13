import * as vscode from "vscode";
import * as cli from "../cli";
import { shortSessionId } from "../sessionDisplay";

const PANEL_TITLE = "Session Detail";

export class SessionDetailPanel {
  public static currentPanel: SessionDetailPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  public static async createOrShow(sessionId: string): Promise<void> {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SessionDetailPanel.currentPanel) {
      SessionDetailPanel.currentPanel._panel.reveal(column);
      await SessionDetailPanel.currentPanel.update(sessionId);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "starling-session",
      PANEL_TITLE,
      column || vscode.ViewColumn.One,
      { enableScripts: false }
    );

    SessionDetailPanel.currentPanel = new SessionDetailPanel(panel);
    await SessionDetailPanel.currentPanel.update(sessionId);
  }

  private async update(sessionId: string): Promise<void> {
    const shortId = shortSessionId(sessionId);
    this._panel.title = `Session ${shortId}`;

    try {
      const meta = await cli.getSession(sessionId);
      this._panel.webview.html = this.renderHtml(meta);
    } catch (err) {
      this._panel.webview.html = `<body><h2>Error loading session</h2><pre>${escapeHtml(String(err))}</pre></body>`;
    }
  }

  private renderHtml(meta: cli.SessionMeta): string {
    const rows: [string, string][] = [
      ["Session ID", shortSessionId(meta.session_id)],
      ["Agent", meta.provider],
      ["Model", meta.model || "-"],
      ["Project", meta.project_path || "-"],
      ["Catalogs", formatCatalogs(meta.catalogs)],
      ["Tokens", formatTokenUsage(meta.token_usage)],
      ["File", meta.file_path],
      ["Modified", meta.modified_at],
    ];

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Session Detail</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
    }
    table { border-collapse: collapse; width: 100%; max-width: 800px; }
    td { padding: 6px 12px; border-bottom: 1px solid var(--vscode-widget-border); }
    td:first-child { color: var(--vscode-descriptionForeground); white-space: nowrap; font-weight: 600; }
    td:last-child { word-break: break-all; }
    .prompt {
      margin-top: 16px;
      padding: 12px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      white-space: pre-wrap;
      word-break: break-word;
    }
    h2 { margin-bottom: 12px; }
  </style>
</head>
<body>
  <h2>Session Detail</h2>
  <table>
    ${rows
      .map(([k, v]) => {
        const fullValue = k === "Session ID" ? meta.session_id : v;
        const title = k === "Session ID" ? `title="${escapeHtml(fullValue)}"` : "";
        return `<tr><td>${escapeHtml(k)}</td><td ${title}>${escapeHtml(v)}</td></tr>`;
      })
      .join("\n")}
  </table>
  ${meta.first_prompt ? `<h3>First Prompt</h3><div class="prompt">${escapeHtml(meta.first_prompt)}</div>` : ""}
</body>
</html>`;
  }

  private dispose(): void {
    SessionDetailPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatTokenUsage(tokenUsage?: cli.TokenUsage): string {
  if (!tokenUsage) {
    return "unknown";
  }

  const input = tokenUsage.input_tokens ?? "-";
  const output = tokenUsage.output_tokens ?? "-";
  const total = tokenUsage.total_tokens ?? "-";
  const cache = tokenUsage.cache_tokens ?? "-";
  return `input: ${input}, output: ${output}, total: ${total}, cache: ${cache}`;
}

function formatCatalogs(catalogs?: Array<{ id: string; name: string }>): string {
  if (!catalogs || catalogs.length === 0) return "-";
  return catalogs.map((catalog) => `${catalog.name} (${catalog.id})`).join(", ");
}
