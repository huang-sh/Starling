import { isJsonObject } from "./types.js";
const PROVIDER_ID = "zhipu-coding-plan";
const BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** Register oh-my-pi's Zhipu Coding Plan provider on the standard Pi SDK runtime. */
export async function registerZhipuCodingPlanProvider(runtime, environment, fetchImpl = (input, init) => fetch(input, init)) {
    if (!runtime.registerProvider)
        return;
    const fallbacks = await fallbackModels(runtime);
    const apiKey = environment.ZHIPU_API_KEY?.trim();
    const discovered = apiKey && !environment.PI_OFFLINE
        ? await discoverModels(apiKey, fallbacks, fetchImpl)
        : undefined;
    runtime.registerProvider(PROVIDER_ID, {
        name: "Zhipu Coding Plan (智谱)",
        baseUrl: BASE_URL,
        apiKey: apiKey || "$ZHIPU_API_KEY",
        api: "openai-completions",
        models: discovered?.length ? discovered : fallbacks,
    });
}
async function discoverModels(apiKey, fallbacks, fetchImpl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
        const response = await fetchImpl(`${BASE_URL}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
        });
        if (!response.ok)
            return undefined;
        const body = await response.json();
        const entries = isJsonObject(body) && Array.isArray(body.data) ? body.data : [];
        const known = new Map(fallbacks.map((model) => [model.id, model]));
        const models = entries
            .map((entry) => dynamicModel(entry, known))
            .filter((model) => model !== undefined);
        return uniqueModels(models);
    }
    catch {
        return undefined;
    }
    finally {
        clearTimeout(timeout);
    }
}
function dynamicModel(entry, known) {
    const id = typeof entry === "string"
        ? entry.trim()
        : isJsonObject(entry) && typeof entry.id === "string"
            ? entry.id.trim()
            : "";
    if (!id)
        return undefined;
    const existing = known.get(id);
    const name = isJsonObject(entry) && typeof entry.name === "string" && entry.name.trim()
        ? entry.name.trim()
        : existing?.name ?? id;
    if (existing)
        return { ...existing, name };
    const model = createFallbackModel(id);
    if (isJsonObject(entry)) {
        const contextWindow = positiveInteger(entry.context_window) ?? positiveInteger(entry.contextWindow);
        const maxTokens = positiveInteger(entry.max_tokens) ?? positiveInteger(entry.maxTokens);
        if (contextWindow)
            model.contextWindow = contextWindow;
        if (maxTokens)
            model.maxTokens = maxTokens;
    }
    return { ...model, name };
}
async function fallbackModels(runtime) {
    const source = await runtime.getModels?.("zai-coding-cn") ?? [];
    const inherited = source
        .map(normalizePiModel)
        .filter((model) => model !== undefined);
    if (inherited.length)
        return uniqueModels(inherited);
    return [
        createFallbackModel("glm-4.5-air", 131_072, 98_304),
        createFallbackModel("glm-4.7", 204_800),
        createFallbackModel("glm-5-turbo"),
        createFallbackModel("glm-5.1"),
        createFallbackModel("glm-5.2", 1_000_000),
        createFallbackModel("glm-5v-turbo"),
    ];
}
function normalizePiModel(value) {
    if (!isJsonObject(value) || typeof value.id !== "string" || !value.id.trim())
        return undefined;
    const model = createFallbackModel(value.id.trim(), positiveInteger(value.contextWindow), positiveInteger(value.maxTokens));
    model.name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : model.id;
    model.reasoning = value.reasoning === true;
    if (Array.isArray(value.input)) {
        const input = value.input.filter((item) => item === "text" || item === "image");
        if (input.length)
            model.input = input;
    }
    if (isJsonObject(value.cost))
        model.cost = value.cost;
    if (isJsonObject(value.thinkingLevelMap))
        model.thinkingLevelMap = value.thinkingLevelMap;
    if (isJsonObject(value.compat))
        model.compat = value.compat;
    return model;
}
function createFallbackModel(id, contextWindow = 200_000, maxTokens = 131_072) {
    const version = Number(id.match(/^glm-(\d+(?:\.\d+)?)/i)?.[1] ?? 0);
    const vision = /^glm-\d+(?:\.\d+)?v(?:-|$)/i.test(id);
    const excluded = /-(?:flashx?|preview)(?:-|$)/i.test(id);
    const reasoning = !vision && !excluded && version >= 4.5;
    const supportsReasoningEffort = reasoning && version >= 5.2;
    return {
        id,
        name: id,
        reasoning,
        input: vision ? ["text", "image"] : ["text"],
        cost: { ...ZERO_COST },
        contextWindow,
        maxTokens,
        ...(supportsReasoningEffort
            ? { thinkingLevelMap: { minimal: null, low: "high", medium: "high", high: "high", max: "max" } }
            : {}),
        compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort,
            thinkingFormat: "zai",
            ...(id === "glm-4.5-air" ? {} : { zaiToolStream: true }),
        },
    };
}
function positiveInteger(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
}
function uniqueModels(models) {
    return [...new Map(models.map((model) => [model.id, model])).values()];
}
