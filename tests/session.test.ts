import { describe, expect, it } from "vitest";
import {
  extractClaudeSessionMeta,
  extractCodexSessionMeta,
} from "../src/lib/session.js";

describe("extractClaudeSessionMeta", () => {
  it("extracts token usage from claude token usage fields", () => {
    const meta = extractClaudeSessionMeta(
      [
        {
          type: "assistant",
          model: "claude-3",
          cwd: "/tmp/proj",
          total_token_usage: {
            input_tokens: 12,
            output_tokens: 8,
            total_tokens: 20,
            cache_creation_input_tokens: 3,
          },
        },
        { type: "user", message: { content: "Hello there" } },
      ],
      "/tmp/proj/session.jsonl",
      "2025-01-01T00:00:00.000Z"
    );

    expect(meta?.token_usage).toEqual({
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20,
      cache_tokens: 3,
    });
  });

  it("extracts token usage from nested claude payloads", () => {
    const meta = extractClaudeSessionMeta(
      [
        {
          type: "assistant",
          message: {
            model: "claude-3-7-sonnet-20250219",
            usage: {
              input_tokens: "34",
              output_tokens: "11",
              total_tokens: "45",
            },
          },
        },
      ],
      "/tmp/proj/session.jsonl",
      "2025-01-01T00:00:00.000Z"
    );

    expect(meta?.token_usage).toEqual({
      input_tokens: 34,
      output_tokens: 11,
      total_tokens: 45,
    });
  });

  it("sums token usage across claude assistant messages", () => {
    const meta = extractClaudeSessionMeta(
      [
        {
          type: "assistant",
          message: {
            model: "claude-3-7-sonnet-20250219",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 100,
            },
          },
        },
        {
          type: "assistant",
          message: {
            model: "claude-3-7-sonnet-20250219",
            usage: {
              input_tokens: 20,
              output_tokens: 7,
              cache_creation_input_tokens: 3,
            },
          },
        },
      ],
      "/tmp/proj/session.jsonl",
      "2025-01-01T00:00:00.000Z"
    );

    expect(meta?.token_usage).toEqual({
      input_tokens: 30,
      output_tokens: 12,
      total_tokens: 42,
      cache_tokens: 103,
    });
  });
});

describe("extractCodexSessionMeta", () => {
  it("extracts token usage from nested codex payloads", () => {
    const meta = extractCodexSessionMeta(
      [
        {
          type: "session_meta",
          payload: { id: "session-1", cwd: "/tmp/codex", model_provider: "codex" },
        },
        {
          type: "turn_context",
          payload: {
            model: "gpt-5",
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "assistant_response",
            info: {
              total_token_usage: {
                inputTokens: "10",
                outputTokens: "5",
                totalTokens: "15",
                cache_read_input_tokens: "2",
              },
            },
          },
        },
      ],
      "/tmp/codex/session.jsonl",
      "2025-01-01T00:00:00.000Z"
    );

    expect(meta?.token_usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cache_tokens: 2,
    });
  });

  it("prefers codex total token usage over last token usage", () => {
    const meta = extractCodexSessionMeta(
      [
        {
          type: "session_meta",
          payload: { id: "session-1", cwd: "/tmp/codex", model_provider: "codex" },
        },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 40,
                output_tokens: 20,
                total_tokens: 120,
              },
              last_token_usage: {
                input_tokens: 3,
                output_tokens: 2,
                total_tokens: 5,
              },
            },
          },
        },
      ],
      "/tmp/codex/session.jsonl",
      "2025-01-01T00:00:00.000Z"
    );

    expect(meta?.token_usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      cache_tokens: 40,
    });
  });

  it("falls back to codex last token usage when cumulative usage is empty", () => {
    const meta = extractCodexSessionMeta(
      [
        {
          type: "session_meta",
          payload: { id: "session-1", cwd: "/tmp/codex", model_provider: "agnes" },
        },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 0,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: 0,
              },
              last_token_usage: {
                input_tokens: 0,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: 8979,
              },
            },
          },
        },
      ],
      "/tmp/codex/session.jsonl",
      "2025-01-01T00:00:00.000Z"
    );

    expect(meta?.token_usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 8979,
      cache_tokens: 0,
    });
  });
});
