/**
 * Per-model token pricing for cost estimates. Fetches the LiteLLM
 * `model_prices_and_context.json` table, cached to disk with a 24h TTL. Any
 * network/parse failure falls back to a small bundled static table — costs
 * always render, they're just marked estimated when sourced from the fallback.
 */
import { dirname, join } from "path";
import { existsSync, readFileSync } from "fs";
import { atomicWriteJSON, readJSON } from "../utils/fs.js";
import { DEFAULT_RUNS_PATH } from "../constants.js";
import type { SessionTokens } from "./sessionMetrics.js";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelRates {
  /** USD per single token. */
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface PricingTable {
  fetchedAt: string;
  source: "litellm" | "fallback";
  rates: Record<string, ModelRates>;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cache: number;
  total: number;
  estimated: boolean;
}

// Bundled fallback rates (USD per token). Values per 1M tokens divided by 1e6.
const PER_M = (n: number) => n / 1_000_000;
const FALLBACK_RATES: { prefix: string; rates: ModelRates }[] = [
  { prefix: "opus", rates: { input: PER_M(15), output: PER_M(75), cacheWrite: PER_M(18.75), cacheRead: PER_M(1.5) } },
  { prefix: "sonnet", rates: { input: PER_M(3), output: PER_M(15), cacheWrite: PER_M(3.75), cacheRead: PER_M(0.3) } },
  { prefix: "haiku", rates: { input: PER_M(1), output: PER_M(5), cacheWrite: PER_M(1.25), cacheRead: PER_M(0.1) } },
];

export function pricingCachePath(): string {
  return process.env.STARLING_PRICING ?? join(dirname(DEFAULT_RUNS_PATH), "pricing-cache.json");
}

function fallbackTable(): PricingTable {
  const rates: Record<string, ModelRates> = {};
  for (const f of FALLBACK_RATES) rates[f.prefix] = f.rates;
  return { fetchedAt: new Date(0).toISOString(), source: "fallback", rates };
}

function toModelRates(raw: unknown): ModelRates | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const num = (k: string): number => {
    const v = r[k];
    return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : 0;
  };
  return {
    input: num("input_cost_per_token"),
    output: num("output_cost_per_token"),
    cacheWrite: num("cache_creation_input_cost_per_token"),
    cacheRead: num("cache_read_input_cost_per_token"),
  };
}

/** Convert a raw LiteLLM-style table into a {key → ModelRates} map. */
export function convertLiteLLM(raw: Record<string, unknown>): Record<string, ModelRates> {
  const out: Record<string, ModelRates> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "sample_spec") continue;
    const rates = toModelRates(value);
    if (rates) out[key.toLowerCase()] = rates;
  }
  return out;
}

function lookupInTable(model: string, rates: Record<string, ModelRates>): ModelRates | null {
  const norm = model.toLowerCase();
  let best: { rate: ModelRates; len: number } | null = null;
  for (const [key, rate] of Object.entries(rates)) {
    let len = 0;
    if (key === norm) len = key.length + 1;
    else if (norm.startsWith(key)) len = key.length;
    else if (key.startsWith(norm)) len = norm.length;
    if (len > 0 && (!best || len > best.len)) best = { rate, len };
  }
  return best?.rate ?? null;
}

function familyFallback(model: string): ModelRates {
  const norm = (model || "").toLowerCase();
  for (const f of FALLBACK_RATES) {
    if (norm.includes(f.prefix)) return f.rates;
  }
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

/**
 * Resolve rates for a model. Tries exact/prefix match in the table, then the
 * bundled family fallback. Returns zero rates when nothing matches.
 */
export function resolveRates(model: string | null | undefined, table?: PricingTable | null): { rates: ModelRates; estimated: boolean } {
  if (model && table && Object.keys(table.rates).length > 0) {
    const hit = lookupInTable(model, table.rates);
    if (hit) return { rates: hit, estimated: table.source === "fallback" };
  }
  return { rates: familyFallback(model ?? ""), estimated: true };
}

/** Cost estimate for a session's cumulative token totals. */
export function costForSession(
  tokens: SessionTokens,
  model: string | null | undefined,
  table?: PricingTable | null
): CostBreakdown {
  const { rates, estimated } = resolveRates(model, table);
  const input = tokens.input * rates.input;
  const output = tokens.output * rates.output;
  // sessionMetrics doesn't split cache write/read; apply the (cheaper) read rate
  // to the whole cache sum as a conservative lower-bound estimate.
  const cache = tokens.cache * rates.cacheRead;
  return { input, output, cache, total: input + output + cache, estimated };
}

async function fetchLiteLLM(fetchImpl?: typeof fetch): Promise<Record<string, ModelRates> | null> {
  const f = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!f) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await f(LITELLM_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return convertLiteLLM(data);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ensure a fresh pricing table is available, fetching from LiteLLM if the cache
 * is stale/missing. Never throws — falls back to the bundled table.
 */
export async function ensurePricing(opts: { fetchImpl?: typeof fetch; now?: number; force?: boolean } = {}): Promise<PricingTable> {
  const now = opts.now ?? Date.now();
  const path = pricingCachePath();

  if (!opts.force) {
    const cached = readJSON<PricingTable>(path);
    if (cached && cached.rates && now - new Date(cached.fetchedAt).getTime() < TTL_MS) {
      return cached;
    }
  }

  const fresh = await fetchLiteLLM(opts.fetchImpl);
  if (fresh && Object.keys(fresh).length > 0) {
    const table: PricingTable = { fetchedAt: new Date(now).toISOString(), source: "litellm", rates: fresh };
    try {
      atomicWriteJSON(path, table);
    } catch {
      /* best-effort persistence */
    }
    return table;
  }

  // Network failed: reuse a still-present stale cache if we have one, else fallback.
  const stale = readJSON<PricingTable>(path);
  if (stale && stale.rates) return stale;
  return fallbackTable();
}
