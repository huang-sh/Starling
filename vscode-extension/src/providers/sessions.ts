import * as vscode from "vscode";
import * as cli from "../cli";
import { shortSessionId } from "../sessionDisplay";

// --- Tree item types ---

class ProviderNode extends vscode.TreeItem {
  constructor(public readonly provider: string) {
    super(provider, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(
      provider === "claude" ? "hubot" : "server"
    );
    this.contextValue = "provider";
  }
}

class SessionNode extends vscode.TreeItem {
  constructor(public readonly meta: cli.SessionMeta, public readonly isPinned: boolean) {
    const shortId = shortSessionId(meta.session_id);
    const promptSummary =
      meta.first_prompt
        ? meta.first_prompt.length > 40
          ? meta.first_prompt.slice(0, 37) + "…"
          : meta.first_prompt
        : "";
    const label = promptSummary
      ? `${shortId} ${promptSummary}`
      : shortId;

    super(
      label,
      vscode.TreeItemCollapsibleState.None
    );
    const project = meta.project_path
      ? meta.project_path.split("/").slice(-2).join("/")
      : "";
    const pinnedSuffix = isPinned ? " (pinned)" : "";
    this.description = `${shortId}  ${meta.model || ""}  ${project}${pinnedSuffix}`;
    this.tooltip = [
      `Session: ${meta.session_id}`,
      `Agent: ${meta.provider}`,
      `Model: ${meta.model || "-"}`,
      `Project: ${meta.project_path || "-"}`,
      `Modified: ${meta.modified_at}`,
      `Tokens: ${formatTokenUsage(meta.token_usage)}`,
      isPinned ? `Pinned: yes` : "Pinned: no",
      meta.first_prompt ? `Prompt: ${meta.first_prompt}` : "",
    ].join("\n");
    this.iconPath = new vscode.ThemeIcon("terminal");
    this.contextValue = isPinned ? "session-pinned" : "session-unpinned";
  }
}

class LoadMoreSessionsNode extends vscode.TreeItem {
  constructor(public readonly provider: string) {
    super("Load more sessions", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("chevron-down");
    this.command = {
      title: "Load more sessions",
      command: "starling.loadMoreSessions",
      arguments: [provider],
    };
    this.contextValue = "session-load-more";
  }
}

type TreeNode = ProviderNode | SessionNode | LoadMoreSessionsNode | vscode.TreeItem;

function errorItem(label: string, err: unknown): vscode.TreeItem {
  const message = err instanceof Error ? err.message : String(err);
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = message.slice(0, 80);
  item.tooltip = message;
  item.iconPath = new vscode.ThemeIcon("error");
  return item;
}

// --- Provider ---

export class SessionsProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private readonly visibleLimits = new Map<string, number>();

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return [new ProviderNode("claude"), new ProviderNode("codex")];
    }
    if (element instanceof ProviderNode) {
      try {
        const limit = this.getVisibleLimit(element.provider);
        if (limit <= 0) {
          const sessions = await cli.listSessions(0, element.provider, { all: true });
          if (sessions.length === 0) {
            return [new vscode.TreeItem("No sessions found", vscode.TreeItemCollapsibleState.None)];
          }
          const pinnedIds = await this.getPinnedSessionIds();
          return sessions.map((s) => new SessionNode(s, pinnedIds.has(s.session_id)));
        }

        const sessions = await cli.listSessions(limit, element.provider);
        if (sessions.length === 0) {
          return [new vscode.TreeItem("No sessions found", vscode.TreeItemCollapsibleState.None)];
        }
        const pinnedIds = await this.getPinnedSessionIds();
        const items: TreeNode[] = sessions.map((s) => new SessionNode(s, pinnedIds.has(s.session_id)));
        if (sessions.length >= limit) {
          items.push(new LoadMoreSessionsNode(element.provider));
        }
        return items;
      } catch (err) {
        return [errorItem("Error loading sessions", err)];
      }
    }
    return [];
  }

  showMoreSessions(provider: string): void {
    const step = getSessionsLimit();
    if (step <= 0) return;

    const current = this.getVisibleLimit(provider);
    this.visibleLimits.set(provider, current + step);
    this._onDidChange.fire();
  }

  resetLimits(): void {
    this.visibleLimits.clear();
    this._onDidChange.fire();
  }

  private getVisibleLimit(provider: string): number {
    const step = getSessionsLimit();
    if (step <= 0) return 0;

    const existing = this.visibleLimits.get(provider);
    return existing ?? step;
  }

  private async getPinnedSessionIds(): Promise<Set<string>> {
    try {
      const pins = await cli.listPins();
      return new Set(pins.map((p) => p.session_id));
    } catch {
      return new Set();
    }
  }
}

function getSessionsLimit(): number {
  const configured = vscode.workspace.getConfiguration("starling").get<number>("sessionTreeLimit", 50);
  const normalized = Number(configured);
  if (!Number.isFinite(normalized)) return 50;
  return Math.max(0, Math.floor(normalized));
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
