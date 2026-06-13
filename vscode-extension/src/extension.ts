import * as vscode from "vscode";
import { SessionsProvider } from "./providers/sessions";
import { SpacesProvider } from "./providers/spaces";
import { ProjectsProvider } from "./providers/projects";
import { SessionDetailPanel } from "./views/sessionDetail";
import * as cli from "./cli";
import { shortSessionId } from "./sessionDisplay";

const outputChannel = vscode.window.createOutputChannel("Starling");

interface QuickPickItem<T> extends vscode.QuickPickItem {
  value: T;
}

export function activate(context: vscode.ExtensionContext): void {
  const sessionsProvider = new SessionsProvider();
  const spacesProvider = new SpacesProvider();
  const projectsProvider = new ProjectsProvider();

  vscode.window.registerTreeDataProvider("starling-sessions", sessionsProvider);
  vscode.window.registerTreeDataProvider("starling-spaces", spacesProvider);
  vscode.window.registerTreeDataProvider("starling-projects", projectsProvider);

  const refreshAllViews = () => {
    cli.clearCliCache();
    sessionsProvider.refresh();
    spacesProvider.refresh();
    projectsProvider.refresh();
  };
  const refreshHandler = () => {
    refreshAllViews();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.refresh", refreshHandler)
  );

  // Core actions
  context.subscriptions.push(
    vscode.commands.registerCommand("starling.resume", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;
      try {
        await resumeSessionInTerminal(sessionId);
      } catch (err) {
        vscode.window.showErrorMessage(`Resume failed: ${errorMessage(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.pin", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;

      const title = await vscode.window.showInputBox({
        title: "Pin title (optional)",
        placeHolder: "Use first prompt as default",
      });
      const tags = await vscode.window.showInputBox({
        title: "Tags (comma-separated, optional)",
      });
      const to = await pickSpaceName("Optional: add to existing catalog");

      try {
        await cli.pinSession(sessionId, {
          title: normalizeOptionalInput(title),
          tags: normalizeOptionalInput(tags),
          to: to ?? undefined,
        });
        vscode.window.showInformationMessage(`Pinned session ${shortSessionId(sessionId)}…`);
        refreshAllViews();
      } catch (err) {
        vscode.window.showErrorMessage(`Pin failed: ${errorMessage(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.pinToSpace", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;

      try {
        const space = await pickSpaceName("Select a catalog");
        if (!space) return;

        await cli.pinSession(sessionId, { to: space });
        vscode.window.showInformationMessage(`Pinned session ${shortSessionId(sessionId)}… to "${space}"`);
        refreshAllViews();
      } catch (err) {
        vscode.window.showErrorMessage(`Pin to catalog failed: ${errorMessage(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.removePin", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;

      try {
        await cli.unpinSession(sessionId);
        vscode.window.showInformationMessage(`Removed pin for ${shortSessionId(sessionId)}…`);
        refreshAllViews();
      } catch (err) {
        vscode.window.showErrorMessage(`Remove pin failed: ${errorMessage(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.deleteSession", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;

      const confirmed = await vscode.window.showWarningMessage(
        `Delete session ${shortSessionId(sessionId)}? This removes the Starling pin and deletes the session file.`,
        { modal: true },
        "Delete Session"
      );
      if (confirmed !== "Delete Session") return;

      try {
        await cli.deleteSession(sessionId);
        vscode.window.showInformationMessage(`Deleted session ${shortSessionId(sessionId)}…`);
        refreshAllViews();
      } catch (err) {
        vscode.window.showErrorMessage(`Delete session failed: ${errorMessage(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.showSession", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;
      await SessionDetailPanel.createOrShow(sessionId);
    })
  );

  // Command-line parity: session
  context.subscriptions.push(
    vscode.commands.registerCommand("starling.sessionList", async () => {
      const agent = await pickAgent("Filter by agent");
      const mode = await vscode.window.showQuickPick(
        [
          { label: "Use default limit", value: "limited" as const },
          { label: "Stream all sessions", value: "all" as const },
        ],
        { placeHolder: "Session list mode" }
      );
      if (!mode) return;

      let limit: number | undefined;
      if (mode.value === "limited") {
        const raw = await vscode.window.showInputBox({
          title: "How many sessions to show?",
          value: "20",
          prompt: "Leave empty for 20",
          validateInput: (value) => {
            if (!value) return undefined;
            const parsed = Number(value);
            return Number.isInteger(parsed) && parsed > 0 ? undefined : "Enter a positive integer";
          },
        });
        if (raw !== undefined) {
          const parsed = Number(raw || "20");
          if (!Number.isInteger(parsed) || parsed <= 0) {
            return;
          }
          limit = parsed;
        }
      }

      await runCliCommandOutput(
        "Starling: session list",
        () => cli.listSessionsText({
          agent,
          all: mode.value === "all",
          limit,
        })
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.sessionShow", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;
      await runCliCommandOutput("Starling: session show", () => cli.getSessionText(sessionId));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.sessionIndexStatus", async () => {
      await runCliCommandOutput("Starling: session index status", () => cli.sessionIndexStatusText());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.sessionIndexRebuild", async () => {
      const agent = await pickAgent("Index agent filter");
      await runCliCommandOutput("Starling: session index rebuild", () => cli.sessionIndexRebuildText(agent));
      refreshAllViews();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.sessionIndexClear", async () => {
      await runCliCommandOutput("Starling: session index clear", () => cli.sessionIndexClearText());
      refreshAllViews();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.loadMoreSessions", (provider: unknown) => {
      const normalized = normalizeSessionProvider(provider);
      if (!normalized) {
        return;
      }
      sessionsProvider.showMoreSessions(normalized);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.loadMoreProjectSessions", (path: unknown) => {
      const projectPath = typeof path === "string" ? path : extractProjectPath(path);
      if (!projectPath) {
        return;
      }
      projectsProvider.showMoreProjectSessions(projectPath);
    })
  );

  // Command-line parity: catalog
  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogList", async () => {
      const pinsOption = await vscode.window.showQuickPick(
        [
          { label: "Catalog list", value: false },
          { label: "Catalog list including pins", value: true },
        ],
        { placeHolder: "Catalog list mode" }
      );
      if (!pinsOption) return;

      await runCliCommandOutput("Starling: catalog list", () =>
        cli.catalogListText({ pins: pinsOption.value })
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogTree", async () => {
      await runCliCommandOutput("Starling: catalog tree", () => cli.catalogTreeText());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.modelList", async () => {
      const agent = await pickAgent("Filter by agent");
      await runCliCommandOutput("Starling: model list", () => cli.modelListText(agent));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogShow", async () => {
      const space = await pickSpace();
      if (!space) return;
      await runCliCommandOutput("Starling: catalog show", () => cli.catalogShowText(space.id));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogCreate", async () => {
      const name = await vscode.window.showInputBox({
        title: "Catalog name",
        prompt: "Required",
        validateInput: (value) => (value.trim() ? undefined : "Catalog name is required"),
      });
      if (!name) return;

      const description = await vscode.window.showInputBox({
        title: "Description (optional)",
      });
      const tags = await vscode.window.showInputBox({
        title: "Tags (comma-separated, optional)",
      });
      const parent = await pickSpaceName("Parent catalog (optional)");

      await runCliCommandOutput("Starling: catalog create", () =>
        cli.createCatalog(name.trim(), {
          description: normalizeOptionalInput(description),
          tags: normalizeOptionalInput(tags),
          parent: normalizeOptionalInput(parent),
        })
      );
      refreshAllViews();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogRemove", async () => {
      const space = await pickSpace();
      if (!space) return;

      const mode = await vscode.window.showQuickPick([
        { label: "Remove catalog", value: "catalog" as const },
        { label: "Remove one session from catalog", value: "pin" as const },
      ], { placeHolder: `Remove from ${space.name}` });
      if (!mode) return;

      if (mode.value === "catalog") {
        const confirm = await vscode.window.showWarningMessage(
          `Remove catalog ${space.name}?`,
          { modal: true },
          "Remove"
        );
        if (confirm !== "Remove") return;
        await runCliCommandOutput("Starling: catalog delete", () => cli.removeCatalog(space.id));
      } else {
        const pins = await cli.listPins(space.id);
        if (pins.length === 0) {
          vscode.window.showInformationMessage(`Catalog ${space.name} has no pins.`);
          return;
        }
        const selected = await pickPinFrom(pins, `Select pin in ${space.name}`);
        if (!selected) return;
        await runCliCommandOutput("Starling: catalog detach", () =>
          cli.removeSessionFromCatalog(space.id, selected.session_id)
        );
      }

      refreshAllViews();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogTag", async () => {
      const space = await pickSpace();
      if (!space) return;

      const tagsInput = normalizeOptionalInput(
        await vscode.window.showInputBox({
          title: `Add tags to ${space.name}`,
          placeHolder: "Comma-separated tags",
        })
      );
      if (!tagsInput) return;

      const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
      if (tags.length === 0) return;

      await runCliCommandOutput("Starling: catalog tag", () => cli.tagCatalog(space.id, tags));
      refreshAllViews();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.catalogEdit", async () => {
      const space = await pickSpace();
      if (!space) return;

      const description = await vscode.window.showInputBox({
        title: "New description (leave empty to skip)",
      });
      const rename = await vscode.window.showInputBox({
        title: "Rename catalog (leave empty to skip)",
      });
      const parent = await pickSpaceName("New parent catalog (leave empty to skip)");

      const patch: {
        description?: string;
        rename?: string;
        parent?: string;
      } = {};

      const normalizedDescription = normalizeOptionalInput(description);
      const normalizedRename = normalizeOptionalInput(rename);
      const normalizedParent = normalizeOptionalInput(parent);
      if (normalizedDescription) patch.description = normalizedDescription;
      if (normalizedRename) patch.rename = normalizedRename;
      if (normalizedParent) patch.parent = normalizedParent;

      if (Object.keys(patch).length === 0) {
        vscode.window.showInformationMessage("No updates provided.");
        return;
      }

      await runCliCommandOutput("Starling: catalog edit", () => cli.editCatalog(space.id, patch));
      refreshAllViews();
    })
  );

  // Command-line parity: project
  context.subscriptions.push(
    vscode.commands.registerCommand("starling.projectList", async () => {
      const agent = await pickAgent("Filter by agent");
      const mode = await vscode.window.showQuickPick(
        [
          { label: "Show recent projects", value: "limited" as const },
          { label: "Scan all sessions", value: "all" as const },
        ],
        { placeHolder: "Project list mode" }
      );
      if (!mode) return;

      let limit = 100;
      if (mode.value === "limited") {
        const raw = await vscode.window.showInputBox({
          title: "Max sessions to scan",
          value: "100",
          validateInput: (value) => {
            if (!value) return undefined;
            const parsed = Number(value);
            return Number.isInteger(parsed) && parsed > 0 ? undefined : "Enter a positive integer";
          },
        });
        if (!raw) return;
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return;
        }
        limit = parsed;
      }

      await runCliCommandOutput("Starling: project list", () =>
        cli.projectListText({
          agent,
          limit: limit,
          all: mode.value === "all",
        })
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.projectShow", async (node: unknown) => {
      const nodePath = extractProjectPath(node);
      const selected = await selectProjectPath(nodePath);
      if (!selected) return;

      const agent = await pickAgent("Filter by agent");
      await runCliCommandOutput("Starling: project show", () => cli.projectShowText(selected, agent));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.openProject", async (node: unknown) => {
      const nodePath = extractProjectPath(node);
      const selected = await selectProjectPath(nodePath);
      if (!selected) return;

      try {
        await openProjectFolderInNewWindow(selected);
      } catch (err) {
        vscode.window.showErrorMessage(`Open project failed: ${errorMessage(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.copyProject", async (node: unknown) => {
      const nodePath = extractProjectPath(node);
      const selected = await selectProjectPath(nodePath);
      if (!selected) return;

      try {
        await vscode.env.clipboard.writeText(selected);
        vscode.window.showInformationMessage(`Copied project path: ${selected}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Copy project path failed: ${errorMessage(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("starling.copySessionId", async (node: unknown) => {
      const sessionId = await pickSessionId(node);
      if (!sessionId) return;

      try {
        await vscode.env.clipboard.writeText(sessionId);
        vscode.window.showInformationMessage(`Copied session ID: ${sessionId}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Copy session ID failed: ${errorMessage(err)}`);
      }
    })
  );

}

export function deactivate(): void {
  // nothing
}

async function runCliCommandOutput(title: string, command: () => Promise<string>): Promise<void> {
  try {
    const text = await command();
    outputChannel.clear();
    outputChannel.appendLine(`[${title}]`);
    outputChannel.appendLine(text.trim());
    outputChannel.show(true);
  } catch (err) {
    vscode.window.showErrorMessage(`${title} failed: ${errorMessage(err)}`);
  }
}

async function openProjectFolderInNewWindow(projectPath: string): Promise<void> {
  const normalized = projectPath.trim();
  if (!normalized) {
    throw new Error("Project path is empty.");
  }

  const uri = vscode.Uri.file(normalized);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    throw new Error(`Cannot open project path: ${projectPath}`);
  }
  await vscode.commands.executeCommand("vscode.openFolder", uri, true);
}

function normalizeOptionalInput(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSessionProvider(value: unknown): "claude" | "codex" | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "claude" || value === "codex") return value;
  return undefined;
}

async function resumeSessionInTerminal(sessionId: string): Promise<void> {
  const resolved = await resolveSessionForResume(sessionId);
  if (!resolved) {
    throw new Error(
      `Session not found: ${shortSessionId(sessionId)}… (try refreshing the session list and retrying)`
    );
  }

  const meta = resolved;
  const terminal = vscode.window.createTerminal({
    name: `starling: ${normalizedSessionLabel(sessionId)}`,
    cwd: meta.project_path || undefined,
  });
  const agent = meta.provider === "codex" ? "codex" : "claude";
  const command = agent === "codex"
    ? `codex resume ${meta.session_id}`
    : `claude --resume ${meta.session_id}`;
  terminal.sendText(command);
  terminal.show();
}

function normalizedSessionLabel(sessionId: string): string {
  return shortSessionId(sessionId.trim());
}

async function resolveSessionForResume(sessionId: string): Promise<cli.SessionMeta | undefined> {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) {
    return undefined;
  }

  try {
    const meta = await cli.getSession(normalized);
    return meta;
  } catch {
    // keep going with fallback when "starling session show" can't resolve exact id
  }

  const sessions = await cli.listSessions(500);
  const exactMatch = sessions.find((session) =>
    session.session_id.toLowerCase() === normalized.toLowerCase()
  );
  if (exactMatch) return exactMatch;

  const shortMatches = sessions.filter((session) =>
    session.session_id.toLowerCase().startsWith(normalized.toLowerCase())
  );
  if (shortMatches.length === 1) return shortMatches[0];

  if (shortMatches.length > 1) {
    const picked = await vscode.window.showQuickPick(
      shortMatches.map((session) => ({
        label: `${session.session_id}`,
        description: `${session.provider} · ${session.project_path || "(no project)"}`,
        detail: session.first_prompt?.slice(0, 80),
        value: session,
      })),
      {
        placeHolder: "Select the session to resume",
      }
    );
    return picked?.value;
  }

  return undefined;
}

function normalizeSessionId(sessionId: string): string {
  return sessionId.trim().replace(/^["']|["']$/g, "");
}

async function pickSessionId(node: unknown): Promise<string | undefined> {
  const direct = extractSessionId(node);
  if (direct) return direct;

  const selected = await pickSession();
  return selected?.session_id;
}

async function pickSpace(): Promise<cli.Space | undefined> {
  const spaces = await cli.listSpaces();
  if (spaces.length === 0) {
    vscode.window.showInformationMessage("No catalogs found.");
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    spaces.map((space) => ({
      label: `${catalogPath(space, spaces)} (${space.id})`,
      description: space.description,
      value: space,
    }))
  );
  return selected?.value as cli.Space | undefined;
}

async function selectProjectPath(nodePath?: string): Promise<string | undefined> {
  if (nodePath) return nodePath;

  const picked = await pickProject();
  if (picked) return picked.project_path;

  const manual = normalizeOptionalInput(
    await vscode.window.showInputBox({
      title: "Project path",
      placeHolder: "/path/to/project",
    })
  );
  return manual;
}

async function pickProject(): Promise<cli.ProjectSummary | undefined> {
  const projects = await cli.listProjects({ all: false, limit: 300 });
  if (projects.length === 0) {
    vscode.window.showInformationMessage("No projects found.");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: project.project_path,
      description: `${project.session_count} sessions`,
      detail: `Last active: ${project.last_active}`,
      value: project,
    })),
    { placeHolder: "Select a project" }
  );
  return picked?.value;
}

function pickSpaceName(placeHolder?: string): Promise<string | undefined> {
  return (async () => {
    const spaces = await cli.listSpaces();
    const items: QuickPickItem<string>[] = spaces.map((space) => ({
      label: `${catalogPath(space, spaces)} (${space.id})`,
      description: space.description,
      value: space.id,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder });
    return picked?.value;
  })();
}

function catalogPath(space: cli.Space, spaces: cli.Space[]): string {
  const parts = [space.name];
  let current = space;
  const seen = new Set<string>();
  while (current.parent_id && !seen.has(current.parent_id)) {
    seen.add(current.parent_id);
    const parent = spaces.find((candidate) => candidate.id === current.parent_id);
    if (!parent) break;
    parts.unshift(parent.name);
    current = parent;
  }
  return parts.join("/");
}

async function pickSession(provider?: "claude" | "codex"): Promise<cli.SessionMeta | undefined> {
  const sessions = await cli.listSessions(200, provider);
  if (sessions.length === 0) {
    vscode.window.showInformationMessage("No sessions found.");
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    sessions.map((session) => ({
      label: `${shortSessionId(session.session_id)}  ${session.provider}  ${session.model || "-"}`,
      description: session.project_path || "(no project)",
      detail: session.first_prompt?.slice(0, 80) || undefined,
      value: session,
    })),
    { placeHolder: "Select a session" }
  );

  return selected?.value;
}

async function pickPin(): Promise<cli.Bookmark | undefined> {
  const pins = await cli.listPins();
  return pickPinFrom(pins, "Select a pin");
}

async function pickPinFrom(pins: cli.Bookmark[], placeHolder: string): Promise<cli.Bookmark | undefined> {
  if (pins.length === 0) {
    vscode.window.showInformationMessage("No pins found.");
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    pins.map((bookmark): QuickPickItem<cli.Bookmark> => ({
      label: `${bookmark.id}  ${shortSessionId(bookmark.session_id)}`,
      description: bookmark.title || "(untitled)",
      detail: bookmark.tags.length > 0 ? `#${bookmark.tags.join(", ")}` : undefined,
      value: bookmark,
    })),
    { placeHolder }
  );

  return selected?.value;
}

async function pickAgent(placeHolder = "Filter by agent"): Promise<"claude" | "codex" | undefined> {
  type AgentPick = {
    label: string;
    value: "claude" | "codex" | undefined;
  };
  const selected = await vscode.window.showQuickPick(
    [
      { label: "claude", value: "claude" as const },
      { label: "codex", value: "codex" as const },
      { label: "all", value: undefined },
    ] as AgentPick[],
    { placeHolder }
  );
  return selected?.value;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface HasSessionMeta {
  meta?: {
    session_id: string;
    project_path?: string | null;
  };
  bookmark?: {
    session_id: string;
    project_path?: string | null;
  };
  project?: { project_path: string };
}

function extractSessionId(node: unknown): string | undefined {
  if (!node) return undefined;
  const obj = node as HasSessionMeta;
  if (obj.meta?.session_id) return obj.meta.session_id;
  if (obj.bookmark?.session_id) return obj.bookmark.session_id;
  return undefined;
}

function extractProjectPath(node: unknown): string | undefined {
  if (!node) return undefined;
  const obj = node as HasSessionMeta & { summary?: { project_path: string } };
  if (obj.project?.project_path) return obj.project.project_path;
  if (obj.bookmark?.project_path) return obj.bookmark.project_path;
  if (obj.meta?.project_path) return obj.meta.project_path;
  if (obj.summary?.project_path) return obj.summary.project_path;
  return undefined;
}
