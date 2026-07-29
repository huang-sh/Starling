import { asError, type PickerHost } from "./picker-host.js";
import { normalizeChatSnapshot } from "./events.js";
import type { StarlingKey } from "./input.js";
export const TREE_SUMMARY_ACTIONS = [
  { id: "none", label: "No summary", description: "Navigate without preserving the abandoned branch" },
  { id: "summary", label: "Summarize", description: "Summarize the abandoned branch into the new path" },
  { id: "custom", label: "Summarize with custom prompt", description: "Provide summarization instructions" },
] as const;

export interface TreePickerEntry {
  id: string;
  parentId: string | null;
  type: string;
  text: string;
  label?: string;
  prefix: string;
  onActivePath: boolean;
  current: boolean;
}

export interface TreePickerState {
  entries: TreePickerEntry[];
  leafId: string | null;
  query: string;
  selected: number;
  stage: "tree" | "summary" | "custom";
  targetId?: string;
  summarySelected: number;
  customPrompt: string;
  working: boolean;
  error?: string;
}

export function treePickerFromResponse(value: unknown): Pick<TreePickerState, "entries" | "leafId"> {
  if (!isRecord(value)) return { entries: [], leafId: null };
  const leafId = typeof value.leafId === "string" ? value.leafId : null;
  const roots = Array.isArray(value.tree) ? value.tree : [];
  const parents = new Map<string, string | null>();
  collectParents(roots, parents);
  const activePath = new Set<string>();
  for (let id = leafId; id; id = parents.get(id) ?? null) activePath.add(id);

  const entries: TreePickerEntry[] = [];
  const orderedRoots = activeFirst(roots, activePath);
  const stack = orderedRoots.slice().reverse().map((node, index) => ({
    node,
    ancestors: [] as boolean[],
    last: index === 0,
  }));
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (!isRecord(item.node) || !isRecord(item.node.entry)) continue;
    const entry = item.node.entry;
    const id = string(entry.id);
    if (!id) continue;
    const children = activeFirst(
      Array.isArray(item.node.children) ? item.node.children : [],
      activePath,
    );
    const prefix = item.ancestors.map((continues) => continues ? "│  " : "   ").join("")
      + (item.ancestors.length > 0 ? item.last ? "└─ " : "├─ " : "");
    entries.push({
      id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      type: string(entry.type) || "entry",
      text: entryText(entry),
      ...(string(item.node.label) ? { label: string(item.node.label) } : {}),
      prefix,
      onActivePath: activePath.has(id),
      current: id === leafId,
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index],
        ancestors: [...item.ancestors, !item.last],
        last: index === children.length - 1,
      });
    }
  }
  return { entries, leafId };
}

function activeFirst(nodes: unknown[], activePath: Set<string>): unknown[] {
  return nodes.map((node, index) => ({ node, index })).sort((left, right) => {
    const leftActive = nodeId(left.node) ? activePath.has(nodeId(left.node)) : false;
    const rightActive = nodeId(right.node) ? activePath.has(nodeId(right.node)) : false;
    return Number(rightActive) - Number(leftActive) || left.index - right.index;
  }).map(({ node }) => node);
}

function nodeId(node: unknown): string {
  return isRecord(node) && isRecord(node.entry) ? string(node.entry.id) : "";
}

export function visibleTreeEntries(picker: TreePickerState): TreePickerEntry[] {
  const query = picker.query.trim().toLocaleLowerCase();
  if (!query) return picker.entries;
  return picker.entries.filter((entry) => [entry.text, entry.label, entry.type]
    .some((value) => value?.toLocaleLowerCase().includes(query)));
}

export function selectedTreeEntry(picker: TreePickerState): TreePickerEntry | undefined {
  return visibleTreeEntries(picker)[picker.selected];
}

function collectParents(nodes: unknown[], output: Map<string, string | null>): void {
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node) || !isRecord(node.entry)) continue;
    const id = string(node.entry.id);
    if (id) output.set(id, typeof node.entry.parentId === "string" ? node.entry.parentId : null);
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
}

function entryText(entry: Record<string, unknown>): string {
  switch (entry.type) {
    case "message": {
      const message = isRecord(entry.message) ? entry.message : {};
      const role = string(message.role) || "message";
      return `${role}: ${contentText(message.content) || "(no content)"}`;
    }
    case "custom_message":
      return `[${string(entry.customType) || "custom"}]: ${contentText(entry.content)}`;
    case "compaction":
      return `[compaction: ${Math.round(number(entry.tokensBefore) / 1000)}k tokens]`;
    case "branch_summary":
      return `[branch summary]: ${string(entry.summary)}`;
    case "model_change":
      return `[model: ${string(entry.modelId)}]`;
    case "thinking_level_change":
      return `[thinking: ${string(entry.thinkingLevel)}]`;
    case "label":
      return `[label: ${string(entry.label)}]`;
    default:
      return `[${string(entry.type) || "entry"}]`;
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return compact(value);
  if (!Array.isArray(value)) return "";
  return compact(value.map((item) => {
    if (!isRecord(item)) return "";
    if (typeof item.text === "string") return item.text;
    if (item.type === "toolCall") return `[${string(item.name) || "tool"}]`;
    return "";
  }).filter(Boolean).join(" "));
}

function compact(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function handleTreePickerKey(host: PickerHost, key: StarlingKey): void {
  const picker = host.state.treePicker;
  if (!picker) return;
  if (picker.working) {
    if (key.type === "escape" || key.type === "ctrl-c") {
      host.sendSessionRequest({ type: "abort_tree_navigation" });
    }
    return;
  }
  if (picker.stage === "custom") {
    if (key.type === "escape" || key.type === "ctrl-c") {
      host.dispatch({ type: "tree.custom.close" });
      return;
    }
    if (key.type === "alt-enter") {
      host.dispatch({ type: "tree.custom.append", value: "\n" });
      return;
    }
    if (key.type === "enter" || key.type === "ctrl-s") {
      const prompt = picker.customPrompt.trim();
      if (!prompt) {
        host.dispatch({ type: "tree.failed", message: "Enter summarization instructions" });
        return;
      }
      if (picker.targetId) void navigateTree(host, picker.targetId, true, prompt);
      return;
    }
    if (key.type === "backspace") {
      host.dispatch({ type: "tree.custom.backspace" });
      return;
    }
    if (key.type === "ctrl-u") {
      host.dispatch({ type: "tree.custom.clear" });
      return;
    }
    if (key.type === "text" || key.type === "paste") {
      host.dispatch({ type: "tree.custom.append", value: key.value });
    }
    return;
  }
  if (picker.stage === "summary") {
    if (key.type === "escape" || key.type === "ctrl-c") {
      host.dispatch({ type: "tree.summary.close" });
      return;
    }
    if (key.type === "up") {
      host.dispatch({ type: "tree.summary.select", delta: -1 });
      return;
    }
    if (key.type === "down" || key.type === "tab") {
      host.dispatch({ type: "tree.summary.select", delta: 1 });
      return;
    }
    if (key.type === "home" || key.type === "end") {
      host.dispatch({
        type: "tree.summary.select",
        delta: key.type === "home"
          ? -picker.summarySelected
          : TREE_SUMMARY_ACTIONS.length - picker.summarySelected - 1,
      });
      return;
    }
    if (key.type === "enter") {
      const action = TREE_SUMMARY_ACTIONS[picker.summarySelected];
      if (!action || !picker.targetId) return;
      if (action.id === "custom") host.dispatch({ type: "tree.custom.open" });
      else void navigateTree(host, picker.targetId, action.id === "summary");
    }
    return;
  }
  if (key.type === "escape" || key.type === "ctrl-c") {
    host.dispatch({ type: picker.query ? "tree.query.clear" : "tree.close" });
    return;
  }
  if (key.type === "up") {
    host.dispatch({ type: "tree.select", delta: -1 });
    return;
  }
  if (key.type === "down") {
    host.dispatch({ type: "tree.select", delta: 1 });
    return;
  }
  if (key.type === "page-up" || key.type === "page-down") {
    host.dispatch({ type: "tree.select", delta: key.type === "page-up" ? -8 : 8 });
    return;
  }
  if (key.type === "home" || key.type === "end") {
    const count = visibleTreeEntries(picker).length;
    host.dispatch({
      type: "tree.select",
      delta: key.type === "home" ? -picker.selected : count - picker.selected - 1,
    });
    return;
  }
  if (key.type === "enter") {
    const entry = selectedTreeEntry(picker);
    if (!entry) return;
    if (entry.current) {
      host.dispatch({ type: "tree.close" });
      host.dispatch({ type: "command.completed", message: "Already at this point" });
    } else {
      host.dispatch({ type: "tree.summary.open", targetId: entry.id });
    }
    return;
  }
  if (key.type === "backspace") {
    host.dispatch({ type: "tree.query.backspace" });
    return;
  }
  if (key.type === "ctrl-u") {
    host.dispatch({ type: "tree.query.clear" });
    return;
  }
  if (key.type === "text" || key.type === "paste") {
    host.dispatch({ type: "tree.query.append", value: key.value });
  }
}

async function navigateTree(
  host: PickerHost,
  targetId: string,
  summarize: boolean,
  customInstructions?: string,
): Promise<void> {
  if (!host.session || !host.state.treePicker || host.state.treePicker.working || host.closing) return;
  const session = host.session;
  host.dispatch({ type: "tree.working" });
  try {
    const result = await session.request({
      type: "navigate_tree",
      targetId,
      summarize,
      ...(customInstructions ? { customInstructions } : {}),
    });
    const navigation = isRecord(result) ? result : {};
    if (navigation.aborted === true) {
      host.dispatch({ type: "tree.failed", message: "Branch summarization cancelled" });
      return;
    }
    if (navigation.cancelled === true) {
      host.dispatch({ type: "tree.close" });
      host.dispatch({ type: "command.completed", message: "Navigation cancelled" });
      return;
    }
    const [stateResponse, messagesResponse] = await Promise.all([
      session.request({ type: "get_state" }),
      session.request({ type: "get_messages" }),
    ]);
    const sessionState = isRecord(stateResponse) ? stateResponse : {};
    const messagesData = isRecord(messagesResponse) ? messagesResponse : {};
    host.dispatch({
      type: "chat.event",
      event: {
        type: "session.snapshot",
        snapshot: normalizeChatSnapshot(
          sessionState,
          Array.isArray(messagesData.messages) ? messagesData.messages : [],
        ),
      },
    });
    if (typeof navigation.editorText === "string" && !host.state.composer.trim()) {
      host.dispatch({ type: "composer.set", value: navigation.editorText });
    }
    host.dispatch({ type: "tree.close" });
    host.dispatch({ type: "command.completed", message: "Navigated to selected point" });
  } catch (error) {
    host.dispatch({ type: "tree.failed", message: asError(error).message });
  }
}
