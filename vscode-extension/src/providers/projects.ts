import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as cli from "../cli";
import { shortSessionId } from "../sessionDisplay";

const PROJECT_SESSION_LIMIT = 30;
const PROJECT_NODE_MAX_LABEL = 32;
const PROJECT_SESSION_LABEL_MAX = 30;
const PROJECT_SESSION_DESC_MAX = 38;
const PROJECT_SESSION_INDEX_CACHE_VERSION = 1;
const STARLING_SESSION_INDEX_FILE = "project-session-index.json";

type TreeNode =
  | ProjectDirectoryNode
  | ProjectNode
  | ProjectSessionNode
  | LoadMoreProjectSessionsNode
  | vscode.TreeItem;

type ProjectDirectoryTree = {
  name: string;
  fullPath: string;
  displayPath: string;
  folders: Map<string, ProjectDirectoryTree>;
  projects: cli.ProjectSummary[];
};

type CachedIndexRecord = {
  version: number;
  builtAt: number;
  data: [string, cli.SessionMeta[]][];
};

type CachedProjectSessionIndex = {
  sessions: SessionIndex;
  builtAt: number;
};

type SessionIndex = Map<string, cli.SessionMeta[]>;

class ProjectDirectoryNode extends vscode.TreeItem {
  constructor(public readonly directory: ProjectDirectoryTree) {
    super(directory.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "project-folder";
    this.iconPath = new vscode.ThemeIcon("folder");
    this.tooltip = directory.displayPath || directory.fullPath || "Projects";
    this.description = directoryDescription(directory);
  }
}

class ProjectNode extends vscode.TreeItem {
  constructor(public readonly project: cli.ProjectSummary) {
    const sessions = project.session_count ?? 0;
    const state =
      sessions > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;

    const shortLabel = lastPathSegment(project.project_path);
    super(truncate(shortLabel, PROJECT_NODE_MAX_LABEL), state);

    this.project = project;
    this.description = sessions > 0 ? `${sessions}` : "";
    this.tooltip = [
      `Project: ${project.project_path}`,
      `Sessions: ${sessions}`,
      `Agents: ${formatAgents(project.agents)}`,
      `Top model: ${formatTopModel(project.models)}`,
      `Last active: ${project.last_active || "-"}`,
    ].join("\n");
    this.contextValue = "project";
    this.iconPath = new vscode.ThemeIcon("repo");
  }
}

class ProjectSessionNode extends vscode.TreeItem {
  constructor(public readonly meta: cli.SessionMeta) {
    const shortSession = shortSessionId(meta.session_id);
    const model = meta.model || "-";
    super(
      truncate(`${shortSession}  ${meta.provider}  ${model}`, PROJECT_SESSION_LABEL_MAX),
      vscode.TreeItemCollapsibleState.None
    );
    this.description = meta.project_path ? truncate(meta.project_path, PROJECT_SESSION_DESC_MAX) : "";
    this.tooltip = [
      `Session: ${meta.session_id}`,
      `Provider: ${meta.provider}`,
      `Model: ${meta.model || "-"}`,
      `Modified: ${meta.modified_at}`,
      `Project: ${meta.project_path || "-"}`,
      `Tokens: ${formatTokenUsage(meta.token_usage)}`,
      `Last prompt: ${meta.first_prompt ?? "-"}`,
    ].join("\n");
    this.contextValue = "project-session";
    this.iconPath = new vscode.ThemeIcon("history");
  }
}

class LoadMoreProjectSessionsNode extends vscode.TreeItem {
  constructor(public readonly projectPath: string) {
    super("Load more sessions", vscode.TreeItemCollapsibleState.None);
    this.contextValue = "project-session-load-more";
    this.iconPath = new vscode.ThemeIcon("chevron-down");
    this.command = {
      title: "Load more project sessions",
      command: "starling.loadMoreProjectSessions",
      arguments: [projectPath],
    };
  }
}

function errorItem(label: string, err: unknown): vscode.TreeItem {
  const message = err instanceof Error ? err.message : String(err);
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.description = message.slice(0, 80);
  item.tooltip = message;
  item.iconPath = new vscode.ThemeIcon("error");
  return item;
}

function formatTopModel(models?: Record<string, number>): string {
  const entries = Object.entries(models || {});
  if (entries.length === 0) {
    return "-";
  }
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] || "-";
}

function formatAgents(agents?: Record<string, number>): string {
  const entries = Object.entries(agents || {});
  if (entries.length === 0) {
    return "-";
  }
  return entries.map(([agent, count]) => `${agent}(${count})`).join(", ");
}

function sortSessionsByModified(sessions: cli.SessionMeta[]): cli.SessionMeta[] {
  return [...sessions].sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `…${trimmed.slice(-(maxLength - 1))}`;
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

export class ProjectsProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private projectSessionIndex?: SessionIndex;
  private projectSessionIndexLoadedAt = 0;
  private projectSessionIndexLoading?: Promise<SessionIndex>;
  private forceRebuildIndex = false;
  private projectSessionVisibleLimits = new Map<string, number>();

  private get cacheFilePath(): string {
    return path.join(os.homedir(), ".starling", STARLING_SESSION_INDEX_FILE);
  }

  refresh(): void {
    this.forceRebuildIndex = true;
    this.scheduleProjectSessionIndexRebuild();
    this.projectSessionVisibleLimits.clear();
    this._onDidChange.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      try {
        const projects = await loadProjectsForTree();
        if (projects.length === 0) {
          return [new vscode.TreeItem("No projects", vscode.TreeItemCollapsibleState.None)];
        }
        if (this.getProjectSessionStale()) {
          this.scheduleProjectSessionIndexRebuild();
        }
        const root = buildProjectTree(projects);
        return getDirectoryChildrenNodes(root);
      } catch (err) {
        return [errorItem("Error loading projects", err)];
      }
    }
    if (element instanceof ProjectDirectoryNode) {
      return getDirectoryChildrenNodes(element.directory);
    }
    if (element instanceof ProjectNode) {
      try {
        const normalizedPath = normalizePathForTree(element.project.project_path);
        const projectSessions = await this.getProjectSessionsForProject(normalizedPath);

        if (projectSessions.loading && projectSessions.sessions.length === 0) {
          return [new vscode.TreeItem("Loading sessions...", vscode.TreeItemCollapsibleState.None)];
        }

        const sessions = projectSessions.sessions;
        const limit = this.getProjectSessionVisibleLimit(element.project.project_path);
        const effectiveLimit = limit <= 0 ? sessions.length : limit;
        const sliced = sessions.slice(0, effectiveLimit);
        if (sliced.length === 0) {
          return [new vscode.TreeItem("(no sessions)", vscode.TreeItemCollapsibleState.None)];
        }
        const children: TreeNode[] = sliced.map((session) => new ProjectSessionNode(session));
        if (effectiveLimit > 0 && sessions.length > effectiveLimit) {
          children.push(new LoadMoreProjectSessionsNode(normalizedPath));
        }
        if (projectSessions.loading) {
          children.unshift(new vscode.TreeItem("Refreshing sessions...", vscode.TreeItemCollapsibleState.None));
        }
        return children;
      } catch (err) {
        return [errorItem(`Failed to load sessions for ${element.project.project_path}`, err)];
      }
    }
    return [];
  }

  showMoreProjectSessions(projectPath: string): void {
    const normalized = normalizePathForTree(projectPath);
    const step = getProjectSessionLimit();
    if (step <= 0) {
      return;
    }
    const current = this.getProjectSessionVisibleLimit(normalized);
    const next = current <= 0 ? step : current + step;
    this.projectSessionVisibleLimits.set(normalized, next);
    this._onDidChange.fire();
  }

  resetProjectSessionLimits(): void {
    this.projectSessionVisibleLimits.clear();
  }

  private getProjectSessionStale(): boolean {
    if (this.forceRebuildIndex) return true;
    if (!this.isProjectSessionIndexFresh()) return true;
    return false;
  }

  private async getProjectSessionsForProject(
    projectPath: string
  ): Promise<{ sessions: cli.SessionMeta[]; loading: boolean }> {
    const normalizedPath = normalizePathForTree(projectPath);
    if (this.projectSessionIndex) {
      const sessions = this.projectSessionIndex.get(normalizedPath) ?? [];
      if (this.getProjectSessionStale()) {
        this.scheduleProjectSessionIndexRebuild();
        return { sessions, loading: true };
      }
      return { sessions, loading: false };
    }

    const cached = await this.loadCachedProjectSessionIndex(true);
    if (cached) {
      this.projectSessionIndex = cached.sessions;
      this.projectSessionIndexLoadedAt = cached.builtAt;
      const stale = this.cacheTtlMs() > 0 && Date.now() - cached.builtAt >= this.cacheTtlMs();
      if (stale) {
        this.forceRebuildIndex = true;
      } else {
        this.forceRebuildIndex = false;
      }
      if (this.getProjectSessionStale()) {
        this.scheduleProjectSessionIndexRebuild();
        return {
          sessions: cached.sessions.get(normalizedPath) ?? [],
          loading: true,
        };
      }

      return {
        sessions: cached.sessions.get(normalizedPath) ?? [],
        loading: false,
      };
    }

    this.scheduleProjectSessionIndexRebuild();
    return { sessions: [], loading: true };
  }

  private scheduleProjectSessionIndexRebuild(): void {
    if (!this.forceRebuildIndex && this.projectSessionIndex && this.isProjectSessionIndexFresh()) {
      return;
    }

    if (this.projectSessionIndexLoading) {
      return;
    }

    const loading = (async () => {
      const sessions = await cli.listSessions(0, undefined, { all: true });
      const index: SessionIndex = new Map();
      for (const session of sessions) {
        if (!session.project_path) continue;
        const normalized = normalizePathForTree(session.project_path);
        const list = index.get(normalized) ?? [];
        list.push(session);
        index.set(normalized, list);
      }
      for (const [pathKey, list] of index.entries()) {
        index.set(pathKey, sortSessionsByModified(list));
      }
      this.projectSessionIndex = index;
      this.projectSessionIndexLoadedAt = Date.now();
      this.forceRebuildIndex = false;
      await this.saveProjectSessionIndex(index, this.projectSessionIndexLoadedAt);
      return index;
    })();

    this.projectSessionIndexLoading = loading;
    loading.finally(() => {
      if (this.projectSessionIndexLoading === loading) {
        this.projectSessionIndexLoading = undefined;
      }
      this._onDidChange.fire();
    });
  }

  private async loadCachedProjectSessionIndex(includeExpired = false): Promise<CachedProjectSessionIndex | undefined> {
    if (this.cacheTtlMs() <= 0) return undefined;

    let text: string;
    try {
      text = await fs.readFile(this.cacheFilePath, "utf8");
    } catch {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
    if (!isCachedIndexRecord(parsed)) return undefined;
    if (!includeExpired && Date.now() - parsed.builtAt >= this.cacheTtlMs()) return undefined;

    try {
      return {
        sessions: new Map(parsed.data),
        builtAt: parsed.builtAt,
      };
    } catch {
      return undefined;
    }
  }

  private async saveProjectSessionIndex(index: SessionIndex, builtAt: number): Promise<void> {
    if (this.cacheTtlMs() <= 0) {
      return;
    }

    const cacheDir = path.dirname(this.cacheFilePath);
    await fs.mkdir(cacheDir, { recursive: true });
    const payload: CachedIndexRecord = {
      version: PROJECT_SESSION_INDEX_CACHE_VERSION,
      builtAt,
      data: Array.from(index.entries()),
    };
    await fs.writeFile(this.cacheFilePath, JSON.stringify(payload), "utf8");
  }

  private isProjectSessionIndexFresh(): boolean {
    if (!this.projectSessionIndex || this.projectSessionIndexLoadedAt <= 0) return false;
    const ttlMs = this.cacheTtlMs();
    if (ttlMs <= 0) return false;
    return Date.now() - this.projectSessionIndexLoadedAt < ttlMs;
  }

  private cacheTtlMs(): number {
    const configured = vscode.workspace.getConfiguration("starling").get<number>("cacheTtlSeconds", 30);
    const ttlSeconds = Number(configured);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return 0;
    return Math.floor(ttlSeconds) * 1000;
  }

  private getProjectSessionVisibleLimit(projectPath: string): number {
    const normalized = normalizePathForTree(projectPath);
    const step = getProjectSessionLimit();
    if (step <= 0) return 0;
    return this.projectSessionVisibleLimits.get(normalized) ?? step;
  }

}

function getProjectSessionLimit(): number {
  const configured = vscode.workspace.getConfiguration("starling").get<number>("projectSessionLimit", PROJECT_SESSION_LIMIT);
  const normalized = Number(configured);
  if (!Number.isFinite(normalized)) return PROJECT_SESSION_LIMIT;
  return Math.max(0, Math.floor(normalized));
}

async function loadProjectsForTree(): Promise<cli.ProjectSummary[]> {
  const opts = { all: true };
  try {
    return await cli.listProjects(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout|timed out|ENOBUFS|maxBuffer|failed|not found/i.test(message)) {
      return cli.listProjects(opts);
    }
    throw err;
  }
}

function getDirectoryChildrenNodes(directory: ProjectDirectoryTree): TreeNode[] {
  const folderNodes = Array.from(directory.folders.values()).sort((a, b) => a.name.localeCompare(b.name));
  const projectNodes = directory.projects
    .slice()
    .sort((a, b) => a.project_path.localeCompare(b.project_path))
    .map((project) => new ProjectNode(project));

  return [...folderNodes.map((folder) => new ProjectDirectoryNode(folder)), ...projectNodes];
}

function buildProjectTree(projects: cli.ProjectSummary[]): ProjectDirectoryTree {
  const displayRoot = selectProjectDisplayRoot(projects);
  const root: ProjectDirectoryTree = {
    name: "",
    fullPath: "",
    displayPath: "",
    folders: new Map(),
    projects: [],
  };

  for (const project of projects) {
    const normalized = normalizePathForTree(project.project_path);
    const segments = projectTreeSegments(normalized, displayRoot);
    const leaf = segments[segments.length - 1] ?? "";
    if (segments.length <= 1) {
      root.projects.push(project);
      continue;
    }

    let current = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      const nextPath = current.fullPath ? `${current.fullPath}/${segment}` : segment;
      const existing = current.folders.get(segment);
      if (existing) {
        current = existing;
        continue;
      }

      const next: ProjectDirectoryTree = {
        name: segment,
        fullPath: nextPath,
        displayPath: displayPathForTreePath(nextPath),
        folders: new Map(),
        projects: [],
      };
      current.folders.set(segment, next);
      current = next;
    }
    if (leaf) {
      current.projects.push(project);
    }
  }

  return sortTree(root);
}

function projectTreeSegments(projectPath: string, displayRoot: string): string[] {
  const workspaceRelative = workspaceRelativeProjectSegments(projectPath);
  if (workspaceRelative.length > 0) {
    return workspaceRelative;
  }

  if (displayRoot && isPathInside(projectPath, displayRoot)) {
    if (projectPath === displayRoot) {
      return [lastPathSegment(displayRoot)];
    }
    const relative = projectPath.slice(displayRoot.length + 1);
    const relativeSegments = relative.split("/").filter(Boolean);
    if (relativeSegments.length > 0) {
      return relativeSegments;
    }
  }

  const segments = projectPath.split("/").filter(Boolean);
  return segments;
}

function workspaceRelativeProjectSegments(projectPath: string): string[] {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const normalizedProject = normalizePathForTree(projectPath);
  const candidates = workspaceFolders
    .map((folder) => normalizePathForTree(folder.uri.fsPath))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const workspaceRoot of candidates) {
    if (normalizedProject === workspaceRoot) {
      return [lastPathSegment(workspaceRoot)];
    }
    if (normalizedProject.startsWith(`${workspaceRoot}/`)) {
      const relative = normalizedProject.slice(workspaceRoot.length + 1);
      const relativeSegments = relative.split("/").filter(Boolean);
      if (relativeSegments.length === 0) {
        return [lastPathSegment(workspaceRoot)];
      }
      return relativeSegments;
    }
  }

  return [];
}

function selectProjectDisplayRoot(projects: cli.ProjectSummary[]): string {
  const projectPaths = projects
    .map((project) => normalizePathForTree(project.project_path))
    .filter(Boolean);
  if (projectPaths.length === 0) {
    return "";
  }

  const candidates = workspaceAncestorCandidates();
  let best = "";
  let bestCoverage = 0;

  for (const candidate of candidates) {
    const coverage = projectPaths.filter((projectPath) => isPathInside(projectPath, candidate)).length;
    if (coverage < 2) {
      continue;
    }
    if (coverage > bestCoverage || (coverage === bestCoverage && candidate.length > best.length)) {
      best = candidate;
      bestCoverage = coverage;
    }
  }

  return best || commonPathPrefix(projectPaths);
}

function workspaceAncestorCandidates(): string[] {
  const roots = vscode.workspace.workspaceFolders ?? [];
  const candidates = new Set<string>();
  for (const folder of roots) {
    let current = normalizePathForTree(folder.uri.fsPath);
    while (current && current !== "/") {
      candidates.add(current);
      const next = normalizePathForTree(path.dirname(current));
      if (!next || next === current || next === ".") {
        break;
      }
      current = next;
    }
  }
  return Array.from(candidates).sort((a, b) => b.length - a.length);
}

function commonPathPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const splitPaths = paths.map((value) => value.split("/").filter(Boolean));
  const prefix: string[] = [];
  const minLength = Math.min(...splitPaths.map((segments) => segments.length));
  for (let index = 0; index < minLength; index += 1) {
    const segment = splitPaths[0][index];
    if (splitPaths.every((segments) => segments[index] === segment)) {
      prefix.push(segment);
      continue;
    }
    break;
  }
  return prefix.length > 0 ? `/${prefix.join("/")}` : "";
}

function isPathInside(pathValue: string, parentPath: string): boolean {
  const normalizedPath = normalizePathForTree(pathValue);
  const normalizedParent = normalizePathForTree(parentPath);
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function displayPathForTreePath(treePath: string): string {
  return treePath.replace(/\/…\//g, "/");
}

function sortTree(directory: ProjectDirectoryTree): ProjectDirectoryTree {
  const folders = new Map<string, ProjectDirectoryTree>();
  const sortedFolders = Array.from(directory.folders.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, folder] of sortedFolders) {
    folders.set(name, sortTree(folder));
  }
  directory.folders = folders;
  directory.projects.sort((a, b) => a.project_path.localeCompare(b.project_path));
  return directory;
}

function normalizePathForTree(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function directoryDescription(directory: ProjectDirectoryTree): string {
  const folderCount = directory.folders.size;
  const projectCount = directory.projects.length;
  const parts: string[] = [];
  if (folderCount > 0) {
    parts.push(`${folderCount} folder${folderCount === 1 ? "" : "s"}`);
  }
  if (projectCount > 0) {
    parts.push(`${projectCount} project${projectCount === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

function lastPathSegment(pathValue: string): string {
  const normalized = normalizePathForTree(pathValue);
  const segments = normalized.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : pathValue.trim();
}

function isCachedIndexRecord(value: unknown): value is CachedIndexRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as CachedIndexRecord;
  if (record.version !== PROJECT_SESSION_INDEX_CACHE_VERSION) return false;
  if (!Number.isFinite(record.builtAt) || record.builtAt <= 0) return false;
  if (!Array.isArray(record.data)) return false;
  return true;
}
