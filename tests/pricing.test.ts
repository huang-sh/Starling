import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  convertLiteLLM,
  costForSession,
  ensurePricing,
  pricingCachePath,
  resolveRates,
} from "../src/lib/pricing.js";

describe("pricing convertLiteLLM", () => {
  it("converts per-token cost fields and lowercases keys", () => {
    const rates = convertLiteLLM({
      "claude-opus-4-test": {
        input_cost_per_token: 0.000015,
        output_cost_per_token: 0.000075,
        cache_creation_input_cost_per_token: 0.00001875,
        cache_read_input_cost_per_token: 0.0000015,
      },
      sample_spec: { note: "skip me" },
    });
    expect(rates["claude-opus-4-test"]).toEqual({
      input: 0.000015,
      output: 0.000075,
      cacheWrite: 0.00001875,
      cacheRead: 0.0000015,
    });
    expect(rates["sample_spec"]).toBeUndefined();
  });
});

describe("pricing resolveRates", () => {
  it("uses an exact/prefix table match when present", () => {
    const table = {
      fetchedAt: new Date().toISOString(),
      source: "litellm" as const,
      rates: {
        "claude-opus-4-test": { input: 1e-5, output: 2e-5, cacheWrite: 3e-5, cacheRead: 4e-6 },
      },
    };
    const { rates, estimated } = resolveRates("claude-opus-4-test", table);
    expect(rates.input).toBe(1e-5);
    expect(estimated).toBe(false);
  });

  it("falls back to bundled family rates (estimated) for unknown models", () => {
    const { rates, estimated } = resolveRates("claude-opus-4-6", null);
    expect(rates.input).toBeCloseTo(15e-6, 9);
    expect(rates.output).toBeCloseTo(75e-6, 9);
    expect(estimated).toBe(true);
  });

  it("returns zero rates for an unrecognized family", () => {
    const { rates } = resolveRates("totally-unknown-model", null);
    expect(rates.input).toBe(0);
    expect(rates.output).toBe(0);
  });
});

describe("pricing costForSession", () => {
  it("multiplies token totals by resolved rates", () => {
    const tokens = { input: 1_000_000, output: 500_000, cache: 2_000_000, total: 1_500_000 };
    const cost = costForSession(tokens, "claude-opus-4-6", null);
    expect(cost.estimated).toBe(true);
    // opus fallback: input $15/1M, output $75/1M, cache (read rate) $1.5/1M
    expect(cost.input).toBeCloseTo(15, 1);
    expect(cost.output).toBeCloseTo(37.5, 1);
    expect(cost.cache).toBeCloseTo(3, 1);
    expect(cost.total).toBeCloseTo(55.5, 1);
  });
});

describe("pricing ensurePricing", () => {
  let prev: string | undefined;
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "starling-pricing-"));
    prev = process.env.STARLING_PRICING;
    process.env.STARLING_PRICING = join(dir, "pricing-cache.json");
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.STARLING_PRICING;
    else process.env.STARLING_PRICING = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the bundled table when the fetcher returns null", async () => {
    const table = await ensurePricing({ fetchImpl: (async () => null) as unknown as typeof fetch, now: Date.now() });
    expect(table.source).toBe("fallback");
    expect(Object.keys(table.rates).length).toBeGreaterThan(0);
    // cache path should reflect the env override
    expect(pricingCachePath()).toBe(process.env.STARLING_PRICING);
  });

  it("uses a fresh litellm table when the fetcher returns prices, and caches it", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        "claude-opus-4-x": { input_cost_per_token: 1e-5, output_cost_per_token: 2e-5 },
      }),
    }) as unknown as typeof fetch);
    const t1 = await ensurePricing({ fetchImpl, now: 1_000_000, force: true });
    expect(t1.source).toBe("litellm");
    expect(t1.rates["claude-opus-4-x"]).toBeDefined();
    // A second call with no force and same now should reuse the on-disk cache.
    const t2 = await ensurePricing({ fetchImpl: (async () => null) as unknown as typeof fetch, now: 1_000_000 });
    expect(t2.source).toBe("litellm");
    expect(t2.rates["claude-opus-4-x"]).toBeDefined();
  });
});
