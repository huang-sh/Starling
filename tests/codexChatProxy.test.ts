import { describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import { startCodexChatProxy, responsesInputToChatMessages, responsesToolsToChatTools } from "../src/lib/codexChatProxy.js";

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

  it("does not expose write_stdin before an exec_command process is running", () => {
    const tools = responsesToolsToChatTools([
      {
        type: "function",
        name: "write_stdin",
        description: "Write to process stdin",
        parameters: {
          type: "object",
          properties: {
            session_id: { type: "integer" },
            chars: { type: "string" },
          },
          required: ["session_id"],
        },
      },
      {
        type: "function",
        name: "exec_command",
        parameters: { type: "object", properties: {} },
      },
    ]);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ function: { name: "exec_command" } });
  });

  it("exposes apply_patch as structured proxy tools for chat completions", () => {
    const tools = responsesToolsToChatTools([
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply patch",
      },
    ]);
    const names = tools.map((tool) => ((tool as Record<string, unknown>).function as Record<string, unknown>).name);

    expect(names).toEqual([
      "apply_patch_add_file",
      "apply_patch_delete_file",
      "apply_patch_update_file",
      "apply_patch_replace_file",
      "apply_patch_batch",
    ]);
    expect(tools[0]).toMatchObject({
      type: "function",
      function: {
        name: "apply_patch_add_file",
        parameters: {
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    });
  });
});

describe("startCodexChatProxy", () => {
  it("reconstructs structured apply_patch proxy calls as Codex custom tool calls", async () => {
    let upstreamRequest: unknown;
    const upstream = await listenJsonServer((body) => {
      upstreamRequest = body;
      return {
        id: "chatcmpl_patch_proxy",
        object: "chat.completion",
        created: 1,
        model: "third-party",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_patch",
                  type: "function",
                  function: {
                    name: "apply_patch_add_file",
                    arguments: JSON.stringify({ path: "demo.txt", content: "hello\n" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
    });
    const proxy = await startCodexChatProxy({
      upstreamBaseUrl: upstream.baseUrl,
      apiKey: "sk-test",
      model: "third-party",
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "third-party",
          stream: false,
          input: "edit file",
          tools: [
            {
              type: "custom",
              name: "apply_patch",
              description: "Apply patch",
            },
          ],
        }),
      });
      const body = await response.json() as { output: Array<Record<string, unknown>> };
      const requestTools = (upstreamRequest as { tools: Array<{ function: { name: string } }> }).tools;

      expect(response.status).toBe(200);
      expect(requestTools.map((tool) => tool.function.name)).toContain("apply_patch_add_file");
      expect(requestTools.map((tool) => tool.function.name)).not.toContain("apply_patch");
      expect(body.output[0]).toMatchObject({
        type: "custom_tool_call",
        call_id: "call_patch",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch",
      });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("returns custom tool calls with freeform input for apply_patch", async () => {
    const upstream = await listenJsonServer((_body) => ({
      id: "chatcmpl_patch",
      object: "chat.completion",
      created: 1,
      model: "third-party",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_patch",
                type: "function",
                function: {
                  name: "apply_patch",
                  arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));
    const proxy = await startCodexChatProxy({
      upstreamBaseUrl: upstream.baseUrl,
      apiKey: "sk-test",
      model: "third-party",
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "third-party",
          stream: false,
          input: "edit file",
          tools: [
            {
              type: "custom",
              name: "apply_patch",
              description: "Apply patch",
            },
          ],
        }),
      });
      const body = await response.json() as { output: Array<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(body.output[0]).toMatchObject({
        type: "custom_tool_call",
        call_id: "call_patch",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch",
      });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("normalizes fenced apply_patch custom tool input", async () => {
    const upstream = await listenJsonServer((_body) => ({
      id: "chatcmpl_patch_fenced",
      object: "chat.completion",
      created: 1,
      model: "third-party",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_patch",
                type: "function",
                function: {
                  name: "apply_patch",
                  arguments: JSON.stringify({
                    input: "```patch\n*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch\n```\n\nDone.",
                  }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));
    const proxy = await startCodexChatProxy({
      upstreamBaseUrl: upstream.baseUrl,
      apiKey: "sk-test",
      model: "third-party",
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "third-party",
          stream: false,
          input: "edit file",
          tools: [
            {
              type: "custom",
              name: "apply_patch",
              description: "Apply patch",
            },
          ],
        }),
      });
      const body = await response.json() as { output: Array<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(body.output[0]).toMatchObject({
        type: "custom_tool_call",
        call_id: "call_patch",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch",
      });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("returns valid JSON for malformed function tool arguments", async () => {
    const upstream = await listenJsonServer((_body) => ({
      id: "chatcmpl_bad_args",
      object: "chat.completion",
      created: 1,
      model: "third-party",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_exec",
                type: "function",
                function: {
                  name: "exec_command",
                  arguments: "{\"cmd\":\"printf 'unterminated",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));
    const proxy = await startCodexChatProxy({
      upstreamBaseUrl: upstream.baseUrl,
      apiKey: "sk-test",
      model: "third-party",
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "third-party",
          stream: false,
          input: "run command",
          tools: [
            {
              type: "function",
              name: "exec_command",
              parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
            },
          ],
        }),
      });
      const body = await response.json() as { output: Array<Record<string, unknown>> };
      const args = JSON.parse(body.output[0].arguments as string) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.output[0]).toMatchObject({
        type: "function_call",
        call_id: "call_exec",
        name: "exec_command",
      });
      expect(args._starling_invalid_arguments).toBe("{\"cmd\":\"printf 'unterminated");
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it("extracts apply_patch from malformed JSON custom tool arguments", async () => {
    const upstream = await listenJsonServer((_body) => ({
      id: "chatcmpl_bad_patch_args",
      object: "chat.completion",
      created: 1,
      model: "third-party",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_patch",
                type: "function",
                function: {
                  name: "apply_patch",
                  arguments: "{\"input\":\"ignore prefix *** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }));
    const proxy = await startCodexChatProxy({
      upstreamBaseUrl: upstream.baseUrl,
      apiKey: "sk-test",
      model: "third-party",
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "third-party",
          stream: false,
          input: "edit file",
          tools: [
            {
              type: "custom",
              name: "apply_patch",
              description: "Apply patch",
            },
          ],
        }),
      });
      const body = await response.json() as { output: Array<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(body.output[0]).toMatchObject({
        type: "custom_tool_call",
        call_id: "call_patch",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: demo.txt\n+hello\n*** End Patch",
      });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});

async function listenJsonServer(handler: (body: unknown) => unknown): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf-8");
    const payload = body ? JSON.parse(body) as unknown : {};
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(handler(payload)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
