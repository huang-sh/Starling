import path from "node:path";

export const MINIMUM_BUNDLED_PI_NODE_VERSION = "22.19.0";

export function bundledPiEnvironment(
  nodeExecutable: string,
  cliEntry: string,
): Record<string, string> {
  return {
    STARLING_BUNDLED_PI_BIN: cliEntry,
    STARLING_BUNDLED_PI_NODE: nodeExecutable,
  };
}

/** Environment used by the native supervisor to start Starling's SDK host. */
export function bundledPiSdkEnvironment(
  nodeExecutable: string,
  hostEntry: string,
): Record<string, string> {
  return {
    STARLING_PI_SDK_HOST: hostEntry,
    STARLING_PI_SDK_NODE: nodeExecutable,
  };
}

function parseNodeVersion(version: string): [number, number, number] | null {
  const match = version.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function nodeSupportsBundledPi(version: string): boolean {
  const actual = parseNodeVersion(version);
  const minimum = parseNodeVersion(MINIMUM_BUNDLED_PI_NODE_VERSION);
  if (!actual || !minimum) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

/**
 * Pi publishes `rpc-entry` and the executable `cli.js` as siblings in dist/.
 * Resolve the public export first, then derive the executable without reaching
 * through package-manager-specific node_modules layouts.
 */
export function piCliPathFromRpcEntry(rpcEntryPath: string): string {
  return path.join(path.dirname(rpcEntryPath), "cli.js");
}

export function piRpcEntryExportTarget(packageJson: unknown): string | null {
  if (!packageJson || typeof packageJson !== "object") return null;
  const exports = (packageJson as Record<string, unknown>).exports;
  if (!exports || typeof exports !== "object") return null;
  const rpcEntry = (exports as Record<string, unknown>)["./rpc-entry"];
  if (typeof rpcEntry === "string") return rpcEntry;
  if (!rpcEntry || typeof rpcEntry !== "object") return null;
  const target = (rpcEntry as Record<string, unknown>).import;
  return typeof target === "string" ? target : null;
}
