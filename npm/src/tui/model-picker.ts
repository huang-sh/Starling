import { asError, type PickerHost, type SessionMetadata } from "./picker-host.js";
import type { StarlingKey } from "./input.js";
export interface ModelPickerModel {
  provider: string;
  id: string;
  name: string;
  selector: string;
  reasoning: boolean;
  thinkingLevels: ModelThinkingLevel[];
  contextWindow?: number;
  maxTokens?: number;
}

export const MODEL_THINKING_LEVELS = [
  { level: "inherit", label: "inherit", description: "Inherit session default" },
  { level: "off", label: "off", description: "No reasoning" },
  { level: "minimal", label: "min", description: "Very brief reasoning" },
  { level: "low", label: "low", description: "Light reasoning" },
  { level: "medium", label: "medium", description: "Moderate reasoning" },
  { level: "high", label: "high", description: "Deep reasoning" },
  { level: "xhigh", label: "xhigh", description: "Extended reasoning" },
  { level: "max", label: "max", description: "Maximum reasoning" },
] as const;

export type ModelThinkingLevel = typeof MODEL_THINKING_LEVELS[number]["level"];
export type ModelPickerStage = "models" | "thinking";

export interface ModelPickerState {
  models: ModelPickerModel[];
  current: string;
  stage: ModelPickerStage;
  /** Empty means all providers. */
  provider: string;
  query: string;
  selected: number;
  actionModel?: ModelPickerModel;
  thinkingSelected: number;
  switching: boolean;
  error?: string;
}

/** Normalize the public Pi SDK model catalog without coupling the TUI to Pi's model type. */
export function availableModelsFromResponse(value: unknown): ModelPickerModel[] {
  const source = isRecord(value) && Array.isArray(value.models) ? value.models : [];
  const models: ModelPickerModel[] = [];
  const seen = new Set<string>();

  for (const item of source) {
    if (!isRecord(item)) continue;
    const provider = text(item.provider);
    const id = text(item.id) || text(item.modelId);
    if (!provider || !id) continue;
    const selector = `${provider}/${id}`;
    if (seen.has(selector)) continue;
    seen.add(selector);
    models.push({
      provider,
      id,
      selector,
      name: text(item.name) || id,
      reasoning: item.reasoning === true,
      thinkingLevels: supportedThinkingLevels(item),
      ...positiveNumber(item.contextWindow, "contextWindow"),
      ...positiveNumber(item.maxTokens, "maxTokens"),
    });
  }
  return models;
}

export function modelPickerProviders(picker: ModelPickerState): string[] {
  return ["", ...new Set(picker.models.map((model) => model.provider))]
    .sort((left, right) => {
      if (!left) return -1;
      if (!right) return 1;
      return left.localeCompare(right);
    });
}

/** OMP-style fuzzy model search over the visible provider scope. */
export function visibleModelPickerModels(picker: ModelPickerState): ModelPickerModel[] {
  const candidates = picker.provider
    ? picker.models.filter((model) => model.provider === picker.provider)
    : [...picker.models];
  const query = picker.query.trim().toLocaleLowerCase();

  if (!query) {
    return candidates.sort((left, right) => {
      const current = Number(right.selector === picker.current) - Number(left.selector === picker.current);
      return current || left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id);
    });
  }

  return candidates
    .map((model) => ({ model, score: modelSearchScore(model, query) }))
    .filter((entry): entry is { model: ModelPickerModel; score: number } => entry.score !== null)
    .sort((left, right) =>
      left.score - right.score
      || Number(right.model.selector === picker.current) - Number(left.model.selector === picker.current)
      || left.model.provider.localeCompare(right.model.provider)
      || left.model.id.localeCompare(right.model.id))
    .map((entry) => entry.model);
}

export function selectedModelPickerModel(picker: ModelPickerState): ModelPickerModel | undefined {
  return visibleModelPickerModels(picker)[picker.selected];
}

export function thinkingOptionsForModel(
  model: ModelPickerModel,
): Array<typeof MODEL_THINKING_LEVELS[number]> {
  const supported = new Set<ModelThinkingLevel>(["inherit", ...model.thinkingLevels]);
  return MODEL_THINKING_LEVELS.filter(({ level }) => supported.has(level));
}

function modelSearchScore(model: ModelPickerModel, query: string): number | null {
  const values = [model.selector, model.id, model.name].map((value) => value.toLocaleLowerCase());
  let best = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (value === query) best = Math.min(best, 0);
    else if (value.startsWith(query)) best = Math.min(best, 10 + value.length - query.length);
    else {
      const contains = value.indexOf(query);
      if (contains >= 0) best = Math.min(best, 100 + contains);
      else {
        const fuzzy = subsequenceScore(value, query);
        if (fuzzy !== null) best = Math.min(best, 1_000 + fuzzy);
      }
    }
  }
  return Number.isFinite(best) ? best : null;
}

function subsequenceScore(value: string, query: string): number | null {
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const character of query) {
    const found = value.indexOf(character, cursor);
    if (found < 0) return null;
    if (first < 0) first = found;
    last = found;
    cursor = found + character.length;
  }
  return first + Math.max(0, last - first - query.length);
}

function positiveNumber(value: unknown, key: "contextWindow" | "maxTokens"): Partial<ModelPickerModel> {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? { [key]: Math.floor(value) }
    : {};
}

function supportedThinkingLevels(model: Record<string, unknown>): ModelThinkingLevel[] {
  if (model.reasoning !== true) return ["off"];
  const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : {};
  return MODEL_THINKING_LEVELS
    .map(({ level }) => level)
    .filter((level): level is Exclude<ModelThinkingLevel, "inherit"> => {
      if (level === "inherit") return false;
      if (map[level] === null) return false;
      if (level === "xhigh" || level === "max") return map[level] !== undefined;
      return true;
    });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function handleModelPickerKey(host: PickerHost, key: StarlingKey): void {
  const picker = host.state.modelPicker;
  if (!picker) return;
  if (picker.stage === "thinking") {
    if (key.type === "escape" || key.type === "ctrl-c") {
      host.dispatch({ type: "model.thinking.close" });
      return;
    }
    if (key.type === "up") {
      host.dispatch({ type: "model.thinking.select", delta: -1 });
      return;
    }
    if (key.type === "down" || key.type === "tab") {
      host.dispatch({ type: "model.thinking.select", delta: 1 });
      return;
    }
    if (key.type === "home" || key.type === "end") {
      const count = picker.actionModel ? thinkingOptionsForModel(picker.actionModel).length : 0;
      host.dispatch({
        type: "model.thinking.select",
        delta: key.type === "home"
          ? -picker.thinkingSelected
          : count - picker.thinkingSelected - 1,
      });
      return;
    }
    if (key.type === "enter") void configureSelectedModel(host);
    return;
  }
  if (key.type === "escape" || key.type === "ctrl-c") {
    host.dispatch({ type: picker.query ? "model.query.clear" : "model.close" });
    return;
  }
  if (key.type === "up") {
    host.dispatch({ type: "model.select", delta: -1 });
    return;
  }
  if (key.type === "down") {
    host.dispatch({ type: "model.select", delta: 1 });
    return;
  }
  if (key.type === "page-up" || key.type === "page-down") {
    host.dispatch({ type: "model.select", delta: key.type === "page-up" ? -8 : 8 });
    return;
  }
  if (key.type === "home" || key.type === "end") {
    const count = visibleModelPickerModels(picker).length;
    host.dispatch({ type: "model.select", delta: key.type === "home" ? -picker.selected : count - picker.selected - 1 });
    return;
  }
  if (key.type === "tab" || key.type === "left" || key.type === "right") {
    host.dispatch({ type: "model.provider", delta: key.type === "left" ? -1 : 1 });
    return;
  }
  if (key.type === "enter") {
    const selected = selectedModelPickerModel(picker);
    if (selected) host.dispatch({ type: "model.thinking.open", model: selected });
    return;
  }
  if (key.type === "backspace") {
    host.dispatch({ type: "model.query.backspace" });
    return;
  }
  if (key.type === "ctrl-u") {
    host.dispatch({ type: "model.query.clear" });
    return;
  }
  if (key.type === "text" || key.type === "paste") {
    host.dispatch({ type: "model.query.append", value: key.value });
  }
}

async function configureSelectedModel(host: PickerHost): Promise<void> {
  const picker = host.state.modelPicker;
  if (!host.session || !picker || picker.stage !== "thinking" || picker.switching || host.closing) return;
  const session = host.session;
  const selected = picker.actionModel;
  if (!selected) return;
  const thinking = thinkingOptionsForModel(selected)[picker.thinkingSelected];
  if (!thinking) return;
  host.dispatch({ type: "model.switching" });
  try {
    await session.request({
      type: "configure_model",
      provider: selected.provider,
      modelId: selected.id,
      thinkingLevel: thinking.level,
    });
    let metadata: SessionMetadata | undefined;
    try {
      metadata = await host.refreshSessionMetadata();
    } catch (error) {
      host.dispatch({
        type: "diagnostic",
        level: "error",
        message: `Session metadata could not be refreshed: ${asError(error).message}`,
      });
    }
    host.dispatch({ type: "model.close" });
    host.dispatch({
      type: "command.completed",
      message: `Model set to ${metadata?.model || selected.selector} · ${thinking.label}`,
    });
  } catch (error) {
    host.dispatch({ type: "model.failed", message: asError(error).message });
  }
}
