import { describe, expect, it } from "vitest";
import { responsesInputToChatMessages, responsesToolsToChatTools } from "../src/lib/codexChatProxy.js";

describe("responsesInputToChatMessages", () => {
  it("keeps function call outputs attached to preceding assistant tool calls", () => {
    const messages = responsesInputToChatMessages([
      {
        type: "function_call",
        call_id: "call_1",
        name: "list_files",
        arguments: "{\"path\":\".\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "README.md\nsrc",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue" }],
      },
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "list_files",
              arguments: "{\"path\":\".\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "README.md\nsrc",
      },
      {
        role: "user",
        content: "continue",
      },
    ]);
  });

  it("groups consecutive function calls before tool outputs", () => {
    const messages = responsesInputToChatMessages([
      { type: "function_call", call_id: "call_1", name: "ls", arguments: "{}" },
      { type: "function_call", call_id: "call_2", name: "git_log", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "files" },
      { type: "function_call_output", call_id: "call_2", output: "commits" },
    ]);

    expect(messages[0]).toMatchObject({
      role: "assistant",
      tool_calls: [
        { id: "call_1", function: { name: "ls", arguments: "{}" } },
        { id: "call_2", function: { name: "git_log", arguments: "{}" } },
      ],
    });
    expect(messages.slice(1)).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "files" },
      { role: "tool", tool_call_id: "call_2", content: "commits" },
    ]);
  });

  it("supports custom_tool_call and custom_tool_call_output", () => {
    const messages = responsesInputToChatMessages([
      {
        type: "custom_tool_call",
        call_id: "call_custom",
        name: "search",
        arguments: "{\"q\":\"todo\"}",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_custom",
        output: "[task list]",
      },
      {
        type: "message",
        role: "assistant",
        content: "done",
      },
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_custom",
            type: "function",
            function: {
              name: "search",
              arguments: "{\"q\":\"todo\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_custom",
        content: "[task list]",
      },
      {
        role: "assistant",
        content: "done",
      },
    ]);
  });

  it("supports tool_search_call and tool_search_output", () => {
    const messages = responsesInputToChatMessages([
      {
        type: "tool_search_call",
        call_id: "call_search",
        namespace: "search",
        tool_name: "duckduckgo",
        input: "latest AI updates",
      },
      {
        type: "tool_search_output",
        call_id: "call_search",
        output: "news list",
      },
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_search",
            type: "function",
            function: {
              name: "search_duckduckgo",
              arguments: "latest AI updates",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_search",
        content: "news list",
      },
    ]);
  });

  it("sanitizes namespaced request tool names for chat completions", () => {
    const tools = responsesToolsToChatTools([
      {
        type: "namespace",
        name: "mcp.github",
        tools: [
          {
            type: "function",
            name: "search/repo",
            description: "Search repos",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ]);

    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "mcp_github_search_repo",
          description: "Search repos",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("preserves reasoning items for conversation replay", () => {
    const messages = responsesInputToChatMessages([
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "I should inspect files first." }],
      },
      {
        type: "message",
        role: "assistant",
        content: "started",
      },
    ]);

    expect(messages).toEqual([
      {
        role: "system",
        content: "Reasoning: I should inspect files first.",
      },
      {
        role: "assistant",
        content: "started",
      },
    ]);
  });
});
