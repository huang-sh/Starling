import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { rpcTimeoutForCommand, StarlingRpcClient } from "../lib/tui/protocol.js";

class FakeChatChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode = null;
  signalCode = null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("RPC timeout policy bounds queries but not non-idempotent operations", () => {
  assert.equal(rpcTimeoutForCommand("get_state", 15000), 15000);
  assert.equal(rpcTimeoutForCommand("get_messages", 15000), 15000);
  assert.equal(rpcTimeoutForCommand("prompt", 15000), undefined);
  assert.equal(rpcTimeoutForCommand("compact", 15000), undefined);
  assert.equal(rpcTimeoutForCommand("fork_session", 15000), undefined);
});

test("prompt remains pending past the query deadline and resolves once acknowledged", async () => {
  const child = new FakeChatChild();
  let request;
  child.stdin.on("data", (chunk) => {
    request = JSON.parse(chunk.toString("utf8"));
  });
  const client = new StarlingRpcClient(child, {
    requestTimeoutMs: 10,
    onRecord: () => {},
    onProtocolError: (error) => assert.fail(error.message),
  });

  const response = client.request("prompt", { message: "Do the work" });
  await delay(25);
  assert.equal(request.type, "prompt");
  const beforeReply = await Promise.race([response.then(() => "resolved"), delay(5).then(() => "pending")]);
  assert.equal(beforeReply, "pending");

  child.stdout.write(`${JSON.stringify({
    type: "response",
    id: request.id,
    command: "prompt",
    success: true,
  })}\n`);
  assert.equal((await response).success, true);
  client.close();
});

test("read-only state request still fails within its bounded deadline", async () => {
  const child = new FakeChatChild();
  child.stdin.resume();
  const client = new StarlingRpcClient(child, {
    requestTimeoutMs: 5,
    onRecord: () => {},
    onProtocolError: (error) => assert.fail(error.message),
  });
  await assert.rejects(client.request("get_state"), /get_state timed out after 5ms/);
  client.close();
});
