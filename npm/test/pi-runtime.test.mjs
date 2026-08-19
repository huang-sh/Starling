import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  MINIMUM_BUNDLED_PI_NODE_VERSION,
  bundledPiEnvironment,
  bundledPiSdkEnvironment,
  nodeSupportsBundledPi,
  piCliPathFromRpcEntry,
  piRpcEntryExportTarget,
} from "../lib/pi-runtime.js";

test("describes the Starling SDK host as Node executable plus host entry", () => {
  assert.deepEqual(
    bundledPiSdkEnvironment("/opt/node", "/pkg/lib/agents/pi/main.js"),
    {
      STARLING_PI_SDK_HOST: "/pkg/lib/agents/pi/main.js",
      STARLING_PI_SDK_NODE: "/opt/node",
    },
  );
});

test("describes bundled Pi as Node executable plus CLI entry", () => {
  assert.deepEqual(
    bundledPiEnvironment(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\pkg\\dist\\cli.js",
    ),
    {
      STARLING_BUNDLED_PI_BIN: "C:\\pkg\\dist\\cli.js",
      STARLING_BUNDLED_PI_NODE: "C:\\Program Files\\nodejs\\node.exe",
    },
  );
});

test("derives bundled Pi CLI from its public rpc-entry export", () => {
  assert.equal(
    piCliPathFromRpcEntry("/pkg/dist/rpc-entry.js"),
    path.join(path.dirname("/pkg/dist/rpc-entry.js"), "cli.js"),
  );
});

test("reads Pi's import-only rpc-entry package export", () => {
  assert.equal(
    piRpcEntryExportTarget({
      exports: { "./rpc-entry": { import: "./dist/rpc-entry.js" } },
    }),
    "./dist/rpc-entry.js",
  );
  assert.equal(piRpcEntryExportTarget({ exports: {} }), null);
});

test("enforces the Node version required by bundled Pi", () => {
  assert.equal(MINIMUM_BUNDLED_PI_NODE_VERSION, "22.19.0");
  assert.equal(nodeSupportsBundledPi("22.18.9"), false);
  assert.equal(nodeSupportsBundledPi("v22.19.0"), true);
  assert.equal(nodeSupportsBundledPi("23.0.0"), true);
  assert.equal(nodeSupportsBundledPi("not-a-version"), false);
});
