import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  buildWindowsTaskkillCommand,
  stopManagedProcessTree,
} from "../lib/tui/process.js";

class FakeManagedProcess extends EventEmitter {
  pid = 4242;
  exitCode = null;
  signalCode = null;
  childKills = [];
  stdin = {
    writable: true,
    end: () => {
      this.stdin.writable = false;
      this.onEnd?.();
    },
  };

  kill(signal = "SIGTERM") {
    this.childKills.push(signal);
    return true;
  }

  closeWithSignal(signal) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.emit("close", null, signal);
  }

  closeNormally() {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = 0;
    this.emit("close", 0, null);
  }
}

test("process-tree shutdown lets supervisor consume EOF before escalation", async () => {
  const child = new FakeManagedProcess();
  child.onEnd = () => child.closeNormally();
  const unixSignals = [];
  const result = await stopManagedProcessTree(child, {
    platform: "linux",
    gracefulTimeoutMs: 5,
    killUnixProcessGroup: (_pid, signal) => unixSignals.push(signal),
  });
  assert.equal(result, "graceful");
  assert.equal(child.stdin.writable, false);
  assert.deepEqual(unixSignals, ["SIGKILL"]);
});

test("an already-exited Unix supervisor still sweeps orphaned group members", async () => {
  const child = new FakeManagedProcess();
  child.closeNormally();
  const unixSignals = [];
  const result = await stopManagedProcessTree(child, {
    platform: "linux",
    killUnixProcessGroup: (_pid, signal) => unixSignals.push(signal),
  });
  assert.equal(result, "already-exited");
  assert.deepEqual(unixSignals, ["SIGKILL"]);
});

test("Unix escalation terminates then kills the detached process group", async () => {
  const child = new FakeManagedProcess();
  const unixSignals = [];
  const result = await stopManagedProcessTree(child, {
    platform: "linux",
    gracefulTimeoutMs: 1,
    terminateTimeoutMs: 1,
    killTimeoutMs: 10,
    killUnixProcessGroup: (_pid, signal) => {
      unixSignals.push(signal);
      if (signal === "SIGKILL") child.closeWithSignal("SIGKILL");
    },
  });
  assert.equal(result, "forced");
  assert.deepEqual(unixSignals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(child.childKills, []);
});

test("Windows escalation invokes taskkill for the complete process tree", async () => {
  const child = new FakeManagedProcess();
  const taskkillPids = [];
  const result = await stopManagedProcessTree(child, {
    platform: "win32",
    gracefulTimeoutMs: 1,
    killTimeoutMs: 10,
    runWindowsTaskkill: async (pid) => {
      taskkillPids.push(pid);
      child.closeWithSignal("SIGKILL");
    },
  });
  assert.equal(result, "forced");
  assert.deepEqual(taskkillPids, [4242]);
  assert.deepEqual(buildWindowsTaskkillCommand(4242), {
    file: "taskkill.exe",
    args: ["/PID", "4242", "/T", "/F"],
  });
});
