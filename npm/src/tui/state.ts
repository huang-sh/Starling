import { basename } from "node:path";
import {
  filterSlashCommands,
  mergeSlashCommands,
  slashQuery,
  type SlashCommandItem,
} from "./commands.js";
import {
  type ChatActivityTone,
  type ChatEvent,
  type ChatInteractionMethod,
  type ChatInteractionRequest,
  type ChatSessionSnapshot,
  type ChatToolState,
  type ChatTranscriptItem,
  isRecord,
  normalizeExtensionUiRequest,
  printable,
} from "./events.js";
import {
  visibleAuthProviders,
  type AuthPickerMode,
  type AuthPickerState,
  type AuthProviderOption,
} from "./auth-picker.js";
import {
  visibleTreeEntries,
  type TreePickerEntry,
  type TreePickerState,
} from "./tree-picker.js";
import {
  MODEL_CONFIG_ACTIONS,
  modelPickerProviders,
  modelRoleThinkingLevel,
  thinkingOptionsForModel,
  visibleModelPickerModels,
  type ModelPickerModel,
  type ModelPickerState,
} from "./model-picker.js";

export type StarlingTuiPhase = "starting" | "ready" | "working" | "stopped" | "error";
export type TimelineKind = "user" | "assistant" | "tool" | "system" | "error";
export type ToolState = ChatToolState;

export interface TimelineEntry {
  id: number;
  kind: TimelineKind;
  text: string;
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  toolState?: ToolState;
  pending?: boolean;
}

export interface ActivityEntry {
  id: number;
  label: string;
  detail: string;
  tone: ChatActivityTone;
}

export type ExtensionUiMethod = ChatInteractionMethod;

export interface ExtensionUiPrompt {
  id: string;
  method: ExtensionUiMethod;
  title: string;
  message: string;
  options: string[];
  selected: number;
  value: string;
  secret: boolean;
  /** UTF-16 index kept on a grapheme boundary. */
  cursor?: number;
}

export type ExtensionUiWidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionUiWidget {
  key: string;
  lines: string[];
  placement: ExtensionUiWidgetPlacement;
}

export interface StarlingTuiState {
  cwd: string;
  workspace: string;
  phase: StarlingTuiPhase;
  status: string;
  ready: boolean;
  busy: boolean;
  compacting: boolean;
  runId?: string;
  sessionId?: string;
  sessionName?: string;
  sessionFile?: string;
  model: string;
  thinking: string;
  queueDepth: number;
  composer: string;
  /** UTF-16 index kept on a grapheme boundary. */
  composerCursor: number;
  /** Submitted prompts/commands, oldest first; consecutive duplicates collapsed. */
  inputHistory: string[];
  /** Cursor into inputHistory; === inputHistory.length means editing the live draft. */
  historyIndex: number;
  /** Composer text saved when history navigation leaves the live draft. */
  historyDraft: string;
  slashCommands: SlashCommandItem[];
  slashMenuOpen: boolean;
  slashSelected: number;
  authPicker?: AuthPickerState;
  treePicker?: TreePickerState;
  modelPicker?: ModelPickerState;
  scrollOffset: number;
  timeline: TimelineEntry[];
  activity: ActivityEntry[];
  statusItems: Record<string, string>;
  widgets: Record<string, ExtensionUiWidget>;
  terminalTitle: string;
  uiPrompt?: ExtensionUiPrompt;
  nextId: number;
}

/**
 * The reducer accepts only Starling semantic events and local view actions.
 * Raw official Pi/Starling records must pass through normalizeChatRecord() first.
 */
export type StarlingTuiAction =
  | { type: "chat.event"; event: ChatEvent }
  | { type: "composer.set"; value: string }
  | { type: "composer.append"; value: string }
  | { type: "composer.backspace" }
  | { type: "composer.delete" }
  | { type: "composer.move"; delta: number }
  | { type: "composer.line"; delta: -1 | 1 }
  | { type: "composer.home" }
  | { type: "composer.end" }
  | { type: "history.push"; text: string }
  | { type: "history.prev" }
  | { type: "history.next" }
  | { type: "slash.loaded"; commands: readonly unknown[] }
  | { type: "slash.select"; delta: number }
  | { type: "slash.dismiss" }
  | { type: "auth.open"; mode: AuthPickerMode; providers: AuthProviderOption[] }
  | { type: "auth.close" }
  | { type: "auth.query.append"; value: string }
  | { type: "auth.query.backspace" }
  | { type: "auth.query.clear" }
  | { type: "auth.select"; delta: number }
  | { type: "auth.working" }
  | { type: "auth.failed"; message: string }
  | { type: "tree.open"; entries: TreePickerEntry[]; leafId: string | null }
  | { type: "tree.close" }
  | { type: "tree.query.append"; value: string }
  | { type: "tree.query.backspace" }
  | { type: "tree.query.clear" }
  | { type: "tree.select"; delta: number }
  | { type: "tree.summary.open"; targetId: string }
  | { type: "tree.summary.close" }
  | { type: "tree.summary.select"; delta: number }
  | { type: "tree.custom.open" }
  | { type: "tree.custom.close" }
  | { type: "tree.custom.append"; value: string }
  | { type: "tree.custom.backspace" }
  | { type: "tree.custom.clear" }
  | { type: "tree.working" }
  | { type: "tree.failed"; message: string }
  | { type: "model.open"; models: ModelPickerModel[]; current: string; roles: Record<string, string> }
  | { type: "model.close" }
  | { type: "model.query.append"; value: string }
  | { type: "model.query.backspace" }
  | { type: "model.query.clear" }
  | { type: "model.select"; delta: number }
  | { type: "model.provider"; delta: number }
  | { type: "model.action.open"; model: ModelPickerModel }
  | { type: "model.action.close" }
  | { type: "model.action.select"; delta: number }
  | { type: "model.thinking.open" }
  | { type: "model.thinking.close" }
  | { type: "model.thinking.select"; delta: number }
  | { type: "model.switching" }
  | { type: "model.failed"; message: string }
  | { type: "prompt.submitted"; text: string; queued: boolean }
  | {
    type: "prompt.rejected";
    text?: string;
    queued?: boolean;
    message: string;
  }
  | { type: "command.submitted"; name: string }
  | { type: "command.completed"; message?: string }
  | { type: "command.failed"; message: string }
  | {
    type: "session.metadata";
    model?: string;
    thinking?: string;
    sessionName?: string;
    sessionId?: string;
    sessionFile?: string;
  }
  | { type: "scroll"; delta: number }
  | { type: "diagnostic"; level: "info" | "error"; message: string }
  | { type: "ui.open"; prompt: ExtensionUiPrompt }
  | { type: "ui.select"; delta: number }
  | { type: "ui.value"; value: string }
  | { type: "ui.append"; value: string }
  | { type: "ui.backspace" }
  | { type: "ui.delete" }
  | { type: "ui.move"; delta: number }
  | { type: "ui.line"; delta: -1 | 1 }
  | { type: "ui.home" }
  | { type: "ui.end" }
  | { type: "ui.close" };

const MAX_TIMELINE_ENTRIES = 1_000;
const MAX_ACTIVITY_ENTRIES = 100;

export function createInitialStarlingTuiState(cwd: string): StarlingTuiState {
  const normalized = cwd.trim() || process.cwd();
  return {
    cwd: normalized,
    workspace: basename(normalized) || normalized,
    phase: "starting",
    status: "Starting agent runtime…",
    ready: false,
    busy: false,
    compacting: false,
    model: "default model",
    thinking: "",
    queueDepth: 0,
    composer: "",
    composerCursor: 0,
    inputHistory: [],
    historyIndex: 0,
    historyDraft: "",
    slashCommands: mergeSlashCommands([]),
    slashMenuOpen: false,
    slashSelected: 0,
    scrollOffset: 0,
    timeline: [],
    activity: [],
    statusItems: {},
    widgets: {},
    terminalTitle: "",
    nextId: 1,
  };
}

export function reduceStarlingTui(
  state: StarlingTuiState,
  action: StarlingTuiAction,
): StarlingTuiState {
  switch (action.type) {
    case "chat.event":
      return reduceChatEvent(state, action.event);
    case "composer.set":
      return updateComposer(state, action.value);
    case "composer.append":
      return insertComposer(state, action.value);
    case "composer.backspace":
      return removeComposerGrapheme(state, -1);
    case "composer.delete":
      return removeComposerGrapheme(state, 1);
    case "composer.move":
      return moveComposerCursor(state, action.delta);
    case "composer.line":
      return {
        ...state,
        composerCursor: moveLineCursor(state.composer, state.composerCursor, action.delta),
      };
    case "composer.home":
      return { ...state, composerCursor: lineStart(state.composer, state.composerCursor) };
    case "composer.end":
      return { ...state, composerCursor: lineEnd(state.composer, state.composerCursor) };
    case "history.push": {
      const text = action.text.trim();
      if (!text) return state;
      const inputHistory = state.inputHistory[state.inputHistory.length - 1] === text
        ? state.inputHistory
        : [...state.inputHistory, text];
      return { ...state, inputHistory, historyIndex: inputHistory.length, historyDraft: "" };
    }
    case "history.prev": {
      if (state.historyIndex === 0) return state;
      const historyDraft = state.historyIndex === state.inputHistory.length
        ? state.composer
        : state.historyDraft;
      const historyIndex = state.historyIndex - 1;
      const composer = state.inputHistory[historyIndex] ?? "";
      return { ...state, historyIndex, historyDraft, composer, composerCursor: composer.length };
    }
    case "history.next": {
      if (state.historyIndex >= state.inputHistory.length) return state;
      const historyIndex = state.historyIndex + 1;
      const composer = historyIndex === state.inputHistory.length
        ? state.historyDraft
        : (state.inputHistory[historyIndex] ?? "");
      return { ...state, historyIndex, composer, composerCursor: composer.length };
    }
    case "slash.loaded": {
      const slashCommands = mergeSlashCommands(action.commands);
      const menu = filterSlashCommands(state.composer, slashCommands);
      return {
        ...state,
        slashCommands,
        slashMenuOpen: state.slashMenuOpen && slashQuery(state.composer) !== null,
        slashSelected: clampSelection(state.slashSelected, menu.length),
      };
    }
    case "slash.select": {
      if (!state.slashMenuOpen) return state;
      const count = filterSlashCommands(state.composer, state.slashCommands).length;
      if (count === 0) return { ...state, slashSelected: 0 };
      return {
        ...state,
        slashSelected: (state.slashSelected + action.delta + count) % count,
      };
    }
    case "slash.dismiss":
      return { ...state, slashMenuOpen: false };
    case "auth.open":
      return {
        ...state,
        authPicker: {
          mode: action.mode,
          providers: action.providers,
          query: "",
          selected: 0,
          working: false,
        },
        slashMenuOpen: false,
      };
    case "auth.close":
      return { ...state, authPicker: undefined };
    case "auth.query.append": {
      if (!state.authPicker || state.authPicker.working) return state;
      const value = action.value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
      if (!value) return state;
      return {
        ...state,
        authPicker: {
          ...state.authPicker,
          query: state.authPicker.query + value,
          selected: 0,
          error: undefined,
        },
      };
    }
    case "auth.query.backspace": {
      if (!state.authPicker || state.authPicker.working) return state;
      const edit = removeTextGrapheme(state.authPicker.query, state.authPicker.query.length, -1);
      return {
        ...state,
        authPicker: { ...state.authPicker, query: edit.value, selected: 0, error: undefined },
      };
    }
    case "auth.query.clear":
      return state.authPicker && !state.authPicker.working
        ? { ...state, authPicker: { ...state.authPicker, query: "", selected: 0, error: undefined } }
        : state;
    case "auth.select": {
      if (!state.authPicker || state.authPicker.working) return state;
      const count = visibleAuthProviders(state.authPicker).length;
      if (count === 0) return { ...state, authPicker: { ...state.authPicker, selected: 0 } };
      return {
        ...state,
        authPicker: {
          ...state.authPicker,
          selected: (state.authPicker.selected + action.delta % count + count) % count,
          error: undefined,
        },
      };
    }
    case "auth.working":
      return state.authPicker
        ? { ...state, authPicker: { ...state.authPicker, working: true, error: undefined } }
        : state;
    case "auth.failed":
      return state.authPicker
        ? { ...state, authPicker: { ...state.authPicker, working: false, error: action.message } }
        : state;
    case "tree.open": {
      const selected = Math.max(0, action.entries.findIndex((entry) => entry.id === action.leafId));
      return {
        ...state,
        treePicker: {
          entries: action.entries,
          leafId: action.leafId,
          query: "",
          selected,
          stage: "tree",
          summarySelected: 0,
          customPrompt: "",
          working: false,
        },
        authPicker: undefined,
        modelPicker: undefined,
        slashMenuOpen: false,
      };
    }
    case "tree.close":
      return { ...state, treePicker: undefined };
    case "tree.query.append": {
      if (!state.treePicker || state.treePicker.stage !== "tree" || state.treePicker.working) return state;
      const value = action.value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
      return value ? {
        ...state,
        treePicker: { ...state.treePicker, query: state.treePicker.query + value, selected: 0, error: undefined },
      } : state;
    }
    case "tree.query.backspace": {
      if (!state.treePicker || state.treePicker.stage !== "tree" || state.treePicker.working) return state;
      const edit = removeTextGrapheme(state.treePicker.query, state.treePicker.query.length, -1);
      return { ...state, treePicker: { ...state.treePicker, query: edit.value, selected: 0, error: undefined } };
    }
    case "tree.query.clear":
      return state.treePicker && state.treePicker.stage === "tree" && !state.treePicker.working
        ? { ...state, treePicker: { ...state.treePicker, query: "", selected: 0, error: undefined } }
        : state;
    case "tree.select": {
      if (!state.treePicker || state.treePicker.stage !== "tree" || state.treePicker.working) return state;
      const count = visibleTreeEntries(state.treePicker).length;
      if (count === 0) return { ...state, treePicker: { ...state.treePicker, selected: 0 } };
      return {
        ...state,
        treePicker: {
          ...state.treePicker,
          selected: (state.treePicker.selected + action.delta % count + count) % count,
          error: undefined,
        },
      };
    }
    case "tree.summary.open":
      return state.treePicker ? {
        ...state,
        treePicker: {
          ...state.treePicker,
          stage: "summary",
          targetId: action.targetId,
          summarySelected: 0,
          error: undefined,
        },
      } : state;
    case "tree.summary.close":
      return state.treePicker
        ? { ...state, treePicker: { ...state.treePicker, stage: "tree", targetId: undefined, error: undefined } }
        : state;
    case "tree.summary.select":
      return state.treePicker && state.treePicker.stage === "summary" && !state.treePicker.working
        ? {
          ...state,
          treePicker: {
            ...state.treePicker,
            summarySelected: (state.treePicker.summarySelected + action.delta % 3 + 3) % 3,
          },
        }
        : state;
    case "tree.custom.open":
      return state.treePicker
        ? { ...state, treePicker: { ...state.treePicker, stage: "custom", customPrompt: "", error: undefined } }
        : state;
    case "tree.custom.close":
      return state.treePicker
        ? { ...state, treePicker: { ...state.treePicker, stage: "summary", error: undefined } }
        : state;
    case "tree.custom.append":
      return state.treePicker && state.treePicker.stage === "custom" && !state.treePicker.working
        ? { ...state, treePicker: { ...state.treePicker, customPrompt: state.treePicker.customPrompt + action.value } }
        : state;
    case "tree.custom.backspace": {
      if (!state.treePicker || state.treePicker.stage !== "custom" || state.treePicker.working) return state;
      const edit = removeTextGrapheme(state.treePicker.customPrompt, state.treePicker.customPrompt.length, -1);
      return { ...state, treePicker: { ...state.treePicker, customPrompt: edit.value } };
    }
    case "tree.custom.clear":
      return state.treePicker && state.treePicker.stage === "custom" && !state.treePicker.working
        ? { ...state, treePicker: { ...state.treePicker, customPrompt: "" } }
        : state;
    case "tree.working":
      return state.treePicker
        ? { ...state, treePicker: { ...state.treePicker, working: true, error: undefined } }
        : state;
    case "tree.failed":
      return state.treePicker
        ? { ...state, treePicker: { ...state.treePicker, working: false, error: action.message } }
        : state;
    case "model.open": {
      const picker: ModelPickerState = {
        models: action.models,
        current: action.current,
        roles: action.roles ?? {},
        stage: "models",
        provider: "",
        query: "",
        selected: 0,
        actionSelected: 0,
        thinkingSelected: 0,
        switching: false,
      };
      return { ...state, modelPicker: picker, authPicker: undefined, treePicker: undefined, slashMenuOpen: false };
    }
    case "model.close":
      return { ...state, modelPicker: undefined };
    case "model.query.append": {
      if (!state.modelPicker || state.modelPicker.stage !== "models" || state.modelPicker.switching) return state;
      const value = action.value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
      if (!value) return state;
      return {
        ...state,
        modelPicker: { ...state.modelPicker, query: state.modelPicker.query + value, selected: 0, error: undefined },
      };
    }
    case "model.query.backspace": {
      if (!state.modelPicker || state.modelPicker.stage !== "models" || state.modelPicker.switching) return state;
      const edit = removeTextGrapheme(state.modelPicker.query, state.modelPicker.query.length, -1);
      return {
        ...state,
        modelPicker: { ...state.modelPicker, query: edit.value, selected: 0, error: undefined },
      };
    }
    case "model.query.clear":
      return state.modelPicker
        ? { ...state, modelPicker: { ...state.modelPicker, query: "", selected: 0, error: undefined } }
        : state;
    case "model.select": {
      if (!state.modelPicker || state.modelPicker.stage !== "models" || state.modelPicker.switching) return state;
      const count = visibleModelPickerModels(state.modelPicker).length;
      if (count === 0) return { ...state, modelPicker: { ...state.modelPicker, selected: 0 } };
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          selected: (state.modelPicker.selected + action.delta % count + count) % count,
          error: undefined,
        },
      };
    }
    case "model.provider": {
      if (!state.modelPicker || state.modelPicker.stage !== "models" || state.modelPicker.switching) return state;
      const providers = modelPickerProviders(state.modelPicker);
      const current = Math.max(0, providers.indexOf(state.modelPicker.provider));
      const provider = providers[(current + action.delta % providers.length + providers.length) % providers.length] ?? "";
      return {
        ...state,
        modelPicker: { ...state.modelPicker, provider, selected: 0, error: undefined },
      };
    }
    case "model.action.open":
      return state.modelPicker
        ? {
          ...state,
          modelPicker: {
            ...state.modelPicker,
            stage: "actions",
            actionModel: action.model,
            actionSelected: 0,
            thinkingSelected: 0,
            error: undefined,
          },
        }
        : state;
    case "model.action.close":
      return state.modelPicker
        ? {
          ...state,
          modelPicker: {
            ...state.modelPicker,
            stage: "models",
            actionModel: undefined,
            actionSelected: 0,
            thinkingSelected: 0,
            switching: false,
            error: undefined,
          },
        }
        : state;
    case "model.action.select": {
      if (!state.modelPicker || state.modelPicker.stage !== "actions" || state.modelPicker.switching) return state;
      const count = MODEL_CONFIG_ACTIONS.length;
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          actionSelected: (state.modelPicker.actionSelected + action.delta % count + count) % count,
          error: undefined,
        },
      };
    }
    case "model.thinking.open": {
      if (!state.modelPicker || state.modelPicker.stage !== "actions" || !state.modelPicker.actionModel) return state;
      const model = state.modelPicker.actionModel;
      const action = MODEL_CONFIG_ACTIONS[state.modelPicker.actionSelected];
      if (!action) return state;
      const options = thinkingOptionsForModel(model);
      const current = modelRoleThinkingLevel(state.modelPicker.roles[action.role], model.selector);
      const selected = options.findIndex(({ level }) => level === current);
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          stage: "thinking",
          thinkingSelected: selected < 0 ? 0 : selected,
          error: undefined,
        },
      };
    }
    case "model.thinking.close":
      return state.modelPicker
        ? {
          ...state,
          modelPicker: {
            ...state.modelPicker,
            stage: "actions",
            thinkingSelected: 0,
            switching: false,
            error: undefined,
          },
        }
        : state;
    case "model.thinking.select": {
      if (!state.modelPicker || state.modelPicker.stage !== "thinking" || state.modelPicker.switching) return state;
      const model = state.modelPicker.actionModel;
      if (!model) return state;
      const count = thinkingOptionsForModel(model).length;
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          thinkingSelected: (state.modelPicker.thinkingSelected + action.delta % count + count) % count,
          error: undefined,
        },
      };
    }
    case "model.switching":
      return state.modelPicker
        ? { ...state, modelPicker: { ...state.modelPicker, switching: true, error: undefined } }
        : state;
    case "model.failed":
      return state.modelPicker
        ? { ...state, modelPicker: { ...state.modelPicker, switching: false, error: action.message } }
        : state;
    case "prompt.submitted": {
      return appendTimeline(
        {
          ...state,
          composer: "",
          composerCursor: 0,
          slashMenuOpen: false,
          slashSelected: 0,
          scrollOffset: 0,
          busy: action.queued ? state.busy : true,
          phase: "working",
          status: action.queued ? "Follow-up queued" : "Sending…",
          queueDepth: action.queued ? state.queueDepth + 1 : state.queueDepth,
        },
        { kind: "user", text: action.text, pending: true },
      );
    }
    case "prompt.rejected": {
      const optimistic = action.text === undefined
        ? -1
        : findLastIndex(
          state.timeline,
          (entry) => entry.kind === "user" && entry.pending === true && entry.text === action.text,
        );
      const composer = state.composer || action.text || "";
      const busy = action.queued ? state.busy : false;
      const next = addActivity(
        {
          ...state,
          phase: busy || state.compacting ? "working" : "ready",
          busy,
          status: busy
            ? "Agent is working…"
            : state.compacting ? "Compacting context…" : "Ready",
          queueDepth: action.queued ? Math.max(0, state.queueDepth - 1) : state.queueDepth,
          composer,
          composerCursor: state.composer ? state.composerCursor : composer.length,
          timeline: optimistic < 0
            ? state.timeline
            : state.timeline.filter((_, index) => index !== optimistic),
        },
        "request",
        action.message,
        "error",
      );
      return appendTimeline(next, { kind: "error", text: action.message });
    }
    case "command.submitted":
      return {
        ...state,
        composer: "",
        composerCursor: 0,
        slashMenuOpen: false,
        slashSelected: 0,
        scrollOffset: 0,
        status: `Running /${action.name}…`,
      };
    case "command.completed": {
      const next = {
        ...state,
        phase: state.busy ? state.phase : "ready" as const,
        status: state.busy ? state.status : "Ready",
      };
      return action.message
        ? appendTimeline(next, { kind: "system", text: action.message })
        : next;
    }
    case "command.failed":
      return appendTimeline(
        addActivity(
          {
            ...state,
            phase: state.busy ? state.phase : "ready",
            status: state.busy ? state.status : "Ready",
          },
          "command",
          action.message,
          "error",
        ),
        { kind: "error", text: action.message },
      );
    case "session.metadata":
      return {
        ...state,
        ...(action.model !== undefined ? { model: action.model || "default model" } : {}),
        ...(action.thinking !== undefined ? { thinking: action.thinking } : {}),
        ...(Object.hasOwn(action, "sessionName") ? { sessionName: action.sessionName } : {}),
        ...(Object.hasOwn(action, "sessionId") ? { sessionId: action.sessionId } : {}),
        ...(Object.hasOwn(action, "sessionFile") ? { sessionFile: action.sessionFile } : {}),
      };
    case "scroll":
      return { ...state, scrollOffset: Math.max(0, state.scrollOffset + action.delta) };
    case "diagnostic":
      return reduceDiagnostic(state, action.level, action.message);
    case "ui.open":
      return openUiPrompt(state, action.prompt);
    case "ui.select": {
      if (!state.uiPrompt || state.uiPrompt.options.length === 0) return state;
      const count = state.uiPrompt.options.length;
      const selected = (state.uiPrompt.selected + action.delta + count) % count;
      return { ...state, uiPrompt: { ...state.uiPrompt, selected } };
    }
    case "ui.value":
      return state.uiPrompt
        ? { ...state, uiPrompt: { ...state.uiPrompt, value: action.value, cursor: action.value.length } }
        : state;
    case "ui.append": {
      if (!state.uiPrompt) return state;
      const edit = insertText(state.uiPrompt.value, promptCursor(state.uiPrompt), action.value);
      return { ...state, uiPrompt: { ...state.uiPrompt, value: edit.value, cursor: edit.cursor } };
    }
    case "ui.backspace":
    case "ui.delete": {
      if (!state.uiPrompt) return state;
      const edit = removeTextGrapheme(
        state.uiPrompt.value,
        promptCursor(state.uiPrompt),
        action.type === "ui.backspace" ? -1 : 1,
      );
      return { ...state, uiPrompt: { ...state.uiPrompt, value: edit.value, cursor: edit.cursor } };
    }
    case "ui.move":
      return state.uiPrompt
        ? {
          ...state,
          uiPrompt: {
            ...state.uiPrompt,
            cursor: moveTextCursor(state.uiPrompt.value, promptCursor(state.uiPrompt), action.delta),
          },
        }
        : state;
    case "ui.line":
      return state.uiPrompt
        ? {
          ...state,
          uiPrompt: {
            ...state.uiPrompt,
            cursor: moveLineCursor(state.uiPrompt.value, promptCursor(state.uiPrompt), action.delta),
          },
        }
        : state;
    case "ui.home":
      return state.uiPrompt
        ? { ...state, uiPrompt: { ...state.uiPrompt, cursor: lineStart(state.uiPrompt.value, promptCursor(state.uiPrompt)) } }
        : state;
    case "ui.end":
      return state.uiPrompt
        ? { ...state, uiPrompt: { ...state.uiPrompt, cursor: lineEnd(state.uiPrompt.value, promptCursor(state.uiPrompt)) } }
        : state;
    case "ui.close":
      return closeUiPrompt(state);
  }
}

/**
 * Backwards-compatible helper for callers that still receive raw extension UI
 * records. Parsing is delegated to the transport normalizer in events.ts.
 */
export function createExtensionUiPrompt(value: Record<string, unknown>): ExtensionUiPrompt | null {
  const request = normalizeExtensionUiRequest(value);
  return request ? promptFromRequest(request) : null;
}

export { isRecord, printable };

function reduceChatEvent(state: StarlingTuiState, event: ChatEvent): StarlingTuiState {
  switch (event.type) {
    case "runtime.started": {
      const cwd = event.cwd || state.cwd;
      return {
        ...state,
        cwd,
        workspace: basename(cwd) || cwd,
        runId: event.runId || state.runId,
        sessionId: event.sessionId || state.sessionId,
        status: "Loading session…",
      };
    }
    case "runtime.exited": {
      const label = event.success
        ? "Session closed"
        : `Agent stopped (${event.exitCode ?? "unknown"})`;
      const next: StarlingTuiState = {
        ...state,
        phase: event.success ? "stopped" : "error",
        ready: false,
        busy: false,
        compacting: false,
        status: label,
        uiPrompt: undefined,
        authPicker: undefined,
        treePicker: undefined,
        modelPicker: undefined,
        slashMenuOpen: false,
      };
      return event.success ? next : addActivity(next, "runtime", label, "error");
    }
    case "session.snapshot":
      return hydrateSnapshot(state, event.snapshot);
    case "session.name.changed":
      return { ...state, sessionName: event.name };
    case "session.thinking.changed":
      return { ...state, thinking: event.level };
    case "turn.started":
      return { ...state, busy: true, phase: "working", status: "Agent is working…" };
    case "turn.generating":
      return { ...state, busy: true, phase: "working", status: "Generating…" };
    case "turn.finalizing":
      return { ...state, status: "Finalizing…" };
    case "turn.settled":
      return state.compacting
        ? { ...state, busy: false, phase: "working", status: "Compacting context…", queueDepth: 0 }
        : { ...state, busy: false, phase: "ready", status: "Ready", queueDepth: 0 };
    case "turn.retrying":
      return addActivity(
        { ...state, busy: true, phase: "working", status: `Retrying (${event.attempt})…` },
        "retry",
        event.message,
        "active",
      );
    case "message.started":
      return startMessage(state, event.message);
    case "message.delta":
      return updateAssistantDelta(state, event.channel, event.delta);
    case "message.completed":
      return finishMessage(state, event.message);
    case "tool.started": {
      const callId = event.callId || `tool-${state.nextId}`;
      return appendTimeline(state, {
        kind: "tool",
        text: event.input,
        toolCallId: callId,
        toolName: event.name,
        toolState: "running",
      });
    }
    case "tool.updated":
      return updateTool(state, event.callId, event.output, "running");
    case "tool.completed":
      return updateTool(
        state,
        event.callId,
        event.output,
        event.failed ? "error" : "done",
        event.name,
      );
    case "queue.changed":
      return { ...state, queueDepth: event.depth };
    case "context.compaction.started":
      return addActivity(
        { ...state, compacting: true, phase: "working", status: "Compacting context…" },
        "context",
        "Compacting",
        "active",
      );
    case "context.compaction.completed": {
      const detail = event.aborted
        ? "Compaction cancelled"
        : event.failed ? event.message || "Compaction failed" : "Compaction complete";
      const tone: ActivityEntry["tone"] = event.aborted
        ? "neutral"
        : event.failed ? "error" : "success";
      return addActivity(
        {
          ...state,
          compacting: false,
          phase: state.busy ? "working" : "ready",
          status: state.busy ? "Agent is working…" : event.failed || event.aborted ? detail : "Ready",
        },
        "context",
        detail,
        tone,
      );
    }
    case "retry.completed":
      return addActivity(
        state,
        "retry",
        event.message,
        event.success ? "success" : "error",
      );
    case "activity.recorded":
      return addActivity(state, event.label, event.detail, event.tone);
    case "status.changed":
      return { ...state, statusItems: updateKeyedValue(state.statusItems, event.key, event.text) };
    case "widget.changed": {
      const widgets = { ...state.widgets };
      if (event.lines === undefined) delete widgets[event.key];
      else {
        widgets[event.key] = {
          key: event.key,
          lines: event.lines,
          placement: event.placement,
        };
      }
      return { ...state, widgets };
    }
    case "terminal.title.changed":
      return { ...state, terminalTitle: event.title };
    case "diagnostic":
      return reduceDiagnostic(state, event.level === "error" ? "error" : "info", event.message);
    case "interaction.requested":
      return openUiPrompt(state, promptFromRequest(event.request));
    case "interaction.dismissed":
      return state.uiPrompt?.id === event.id ? closeUiPrompt(state) : state;
    case "composer.replaced":
      return updateComposer(state, event.value);
  }
}

/** Collapse only-adjacent duplicates while preserving order. */
function dedupeHistory(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (out[out.length - 1] !== entry) out.push(entry);
  }
  return out;
}

function hydrateSnapshot(state: StarlingTuiState, snapshot: ChatSessionSnapshot): StarlingTuiState {
  const normalized = transcriptToTimeline(snapshot.transcript, state.nextId);
  const compacting = snapshot.compacting === true;
  const working = snapshot.streaming || compacting;
  // Seed recall history from the resumed session's prior user turns so Up can
  // surface them immediately, not just prompts typed this run.
  const inputHistory = dedupeHistory(
    snapshot.transcript
      .filter((item) => item.kind === "user" && item.text.trim())
      .map((item) => item.text.trim()),
  );
  return {
    ...state,
    phase: working ? "working" : "ready",
    status: snapshot.streaming
      ? "Agent is working…"
      : compacting ? "Compacting context…" : "Ready",
    ready: true,
    busy: snapshot.streaming,
    compacting,
    sessionId: snapshot.sessionId,
    sessionName: snapshot.sessionName,
    sessionFile: snapshot.sessionFile,
    model: snapshot.model,
    thinking: snapshot.thinking,
    queueDepth: snapshot.queueDepth,
    timeline: normalized.timeline,
    nextId: normalized.nextId,
    inputHistory,
    historyIndex: inputHistory.length,
    historyDraft: "",
  };
}

function startMessage(state: StarlingTuiState, message: ChatTranscriptItem): StarlingTuiState {
  if (message.kind === "user") {
    const last = state.timeline.at(-1);
    if (last?.kind === "user" && last.pending && last.text === message.text) {
      return {
        ...state,
        timeline: state.timeline.map((entry, index) =>
          index === state.timeline.length - 1 ? { ...entry, pending: false } : entry),
      };
    }
    return message.text
      ? appendTimeline(state, { ...message, kind: "user", pending: false })
      : state;
  }
  if (message.kind === "assistant") {
    return appendTimeline(state, { ...message, kind: "assistant", pending: true });
  }
  if (message.kind === "system" || message.kind === "error") {
    return message.text ? appendTimeline(state, message) : state;
  }
  return state;
}

function updateAssistantDelta(
  state: StarlingTuiState,
  channel: "text" | "thinking",
  delta: string,
): StarlingTuiState {
  if (!delta) return state;
  let index = findLastIndex(state.timeline, (entry) => entry.kind === "assistant" && entry.pending === true);
  let next = state;
  if (index < 0) {
    next = appendTimeline(state, { kind: "assistant", text: "", pending: true });
    index = next.timeline.length - 1;
  }
  return {
    ...next,
    timeline: next.timeline.map((entry, entryIndex) => {
      if (entryIndex !== index) return entry;
      return channel === "thinking"
        ? { ...entry, thinking: (entry.thinking || "") + delta }
        : { ...entry, text: entry.text + delta };
    }),
  };
}

function finishMessage(state: StarlingTuiState, message: ChatTranscriptItem): StarlingTuiState {
  if (message.kind !== "assistant") return state;
  const index = findLastIndex(state.timeline, (entry) => entry.kind === "assistant" && entry.pending === true);
  if (index < 0) return appendTimeline(state, { ...message, kind: "assistant", pending: false });
  return {
    ...state,
    timeline: state.timeline.map((entry, entryIndex) => entryIndex === index
      ? {
        ...entry,
        text: message.text || entry.text,
        thinking: message.thinking || entry.thinking,
        pending: false,
      }
      : entry),
  };
}

function updateTool(
  state: StarlingTuiState,
  toolCallId: string,
  text: string,
  toolState: ToolState,
  toolName = "tool",
): StarlingTuiState {
  if (!toolCallId) return state;
  const index = findLastIndex(state.timeline, (entry) => entry.toolCallId === toolCallId);
  if (index < 0) {
    return appendTimeline(state, {
      kind: "tool",
      text,
      toolCallId,
      toolName,
      toolState,
    });
  }
  return {
    ...state,
    timeline: state.timeline.map((entry, entryIndex) => entryIndex === index
      ? { ...entry, text: text || entry.text, toolName: entry.toolName || toolName, toolState }
      : entry),
  };
}

function transcriptToTimeline(
  transcript: readonly ChatTranscriptItem[],
  startId: number,
): { timeline: TimelineEntry[]; nextId: number } {
  let nextId = startId;
  const timeline = transcript.slice(-MAX_TIMELINE_ENTRIES).map((entry) => ({
    id: nextId++,
    ...entry,
  }));
  return { timeline, nextId };
}

function appendTimeline(
  state: StarlingTuiState,
  entry: Omit<TimelineEntry, "id">,
): StarlingTuiState {
  return {
    ...state,
    timeline: [...state.timeline, { id: state.nextId, ...entry }].slice(-MAX_TIMELINE_ENTRIES),
    nextId: state.nextId + 1,
  };
}

function addActivity(
  state: StarlingTuiState,
  label: string,
  detail: string,
  tone: ActivityEntry["tone"],
): StarlingTuiState {
  const cleanDetail = compactWhitespace(detail);
  if (!cleanDetail) return state;
  return {
    ...state,
    activity: [
      ...state.activity,
      { id: state.nextId, label, detail: cleanDetail, tone },
    ].slice(-MAX_ACTIVITY_ENTRIES),
    nextId: state.nextId + 1,
  };
}

function reduceDiagnostic(
  state: StarlingTuiState,
  level: "info" | "error",
  rawMessage: string,
): StarlingTuiState {
  const message = compactWhitespace(rawMessage);
  if (!message) return state;
  return addActivity(
    level === "error" ? { ...state, status: message } : state,
    level === "error" ? "error" : "log",
    message,
    level === "error" ? "error" : "neutral",
  );
}

function promptCursor(prompt: ExtensionUiPrompt): number {
  return prompt.cursor ?? prompt.value.length;
}

function promptFromRequest(request: ChatInteractionRequest): ExtensionUiPrompt {
  return {
    id: request.id,
    method: request.method,
    title: request.title,
    message: request.message,
    options: request.options,
    selected: 0,
    value: request.initialValue,
    secret: request.secret,
    cursor: request.initialValue.length,
  };
}

function openUiPrompt(state: StarlingTuiState, prompt: ExtensionUiPrompt): StarlingTuiState {
  return addActivity(
    {
      ...state,
      uiPrompt: prompt,
      slashMenuOpen: false,
      status: prompt.title || "Input requested",
    },
    "attention",
    prompt.title || `${prompt.method} requested`,
    "active",
  );
}

function closeUiPrompt(state: StarlingTuiState): StarlingTuiState {
  return {
    ...state,
    uiPrompt: undefined,
    status: state.busy
      ? "Agent is working…"
      : state.compacting ? "Compacting context…" : "Ready",
  };
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface TextEdit {
  value: string;
  cursor: number;
}

function insertText(value: string, cursor: number, inserted: string): TextEdit {
  const at = clampCursor(value, cursor);
  const nextValue = value.slice(0, at) + inserted + value.slice(at);
  return {
    value: nextValue,
    cursor: ceilCursor(nextValue, at + inserted.length),
  };
}

function removeTextGrapheme(value: string, cursor: number, direction: -1 | 1): TextEdit {
  const boundaries = graphemeBoundaries(value);
  const at = boundaryIndex(boundaries, clampCursor(value, cursor));
  const startIndex = direction < 0 ? at - 1 : at;
  const endIndex = startIndex + 1;
  if (startIndex < 0 || endIndex >= boundaries.length) return { value, cursor: boundaries[at] ?? 0 };
  const start = boundaries[startIndex] ?? 0;
  const end = boundaries[endIndex] ?? start;
  return { value: value.slice(0, start) + value.slice(end), cursor: start };
}

function moveTextCursor(value: string, cursor: number, delta: number): number {
  const boundaries = graphemeBoundaries(value);
  const index = boundaryIndex(boundaries, clampCursor(value, cursor));
  const next = Math.min(Math.max(0, index + Math.trunc(delta)), boundaries.length - 1);
  return boundaries[next] ?? value.length;
}

function insertComposer(state: StarlingTuiState, value: string): StarlingTuiState {
  const edit = insertText(state.composer, state.composerCursor, value);
  return updateComposer(state, edit.value, edit.cursor);
}

function removeComposerGrapheme(state: StarlingTuiState, direction: -1 | 1): StarlingTuiState {
  const edit = removeTextGrapheme(state.composer, state.composerCursor, direction);
  if (edit.value === state.composer && edit.cursor === state.composerCursor) return state;
  return updateComposer(state, edit.value, edit.cursor);
}

function moveComposerCursor(state: StarlingTuiState, delta: number): StarlingTuiState {
  return { ...state, composerCursor: moveTextCursor(state.composer, state.composerCursor, delta) };
}

function updateComposer(
  state: StarlingTuiState,
  composer: string,
  cursor = composer.length,
): StarlingTuiState {
  const slashMenuOpen = slashQuery(composer) !== null && state.slashCommands.length > 0;
  return {
    ...state,
    composer,
    composerCursor: clampCursor(composer, cursor),
    slashMenuOpen,
    slashSelected: 0,
  };
}

function graphemeBoundaries(value: string): number[] {
  const boundaries = [0];
  for (const part of graphemeSegmenter.segment(value)) boundaries.push(part.index + part.segment.length);
  return boundaries;
}

function boundaryIndex(boundaries: readonly number[], cursor: number): number {
  const exact = boundaries.indexOf(cursor);
  if (exact >= 0) return exact;
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    if ((boundaries[index] ?? 0) < cursor) return index;
  }
  return 0;
}

function clampCursor(value: string, cursor: number): number {
  const bounded = Math.min(Math.max(0, Math.trunc(cursor)), value.length);
  const boundaries = graphemeBoundaries(value);
  return boundaries[boundaryIndex(boundaries, bounded)] ?? 0;
}

function ceilCursor(value: string, cursor: number): number {
  const bounded = Math.min(Math.max(0, Math.trunc(cursor)), value.length);
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary >= bounded) return boundary;
  }
  return value.length;
}

function lineStart(value: string, cursor: number): number {
  if (cursor <= 0) return 0;
  return value.lastIndexOf("\n", cursor - 1) + 1;
}

function lineEnd(value: string, cursor: number): number {
  const end = value.indexOf("\n", cursor);
  return end < 0 ? value.length : end;
}

function moveLineCursor(value: string, cursor: number, delta: -1 | 1): number {
  const at = clampCursor(value, cursor);
  const start = lineStart(value, at);
  const column = graphemeBoundaries(value.slice(start, at)).length - 1;
  let targetStart: number;
  if (delta < 0) {
    if (start === 0) return at;
    targetStart = lineStart(value, start - 1);
  } else {
    const currentEnd = lineEnd(value, at);
    if (currentEnd >= value.length) return at;
    targetStart = currentEnd + 1;
  }
  const targetEnd = lineEnd(value, targetStart);
  const targetBoundaries = graphemeBoundaries(value.slice(targetStart, targetEnd));
  const targetColumn = Math.min(column, targetBoundaries.length - 1);
  return targetStart + (targetBoundaries[targetColumn] ?? 0);
}

function updateKeyedValue(
  values: Readonly<Record<string, string>>,
  key: string,
  value: string | undefined,
): Record<string, string> {
  const next = { ...values };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function clampSelection(selected: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, selected), count - 1);
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}
