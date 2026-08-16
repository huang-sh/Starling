import path from "node:path";
export const MINIMUM_BUNDLED_PI_NODE_VERSION = "22.19.0";
export function bundledPiEnvironment(nodeExecutable, cliEntry) {
    return {
        STARLING_BUNDLED_PI_BIN: cliEntry,
        STARLING_BUNDLED_PI_NODE: nodeExecutable,
    };
}
/** Environment used by the native supervisor to start Starling's SDK host. */
export function bundledPiSdkEnvironment(nodeExecutable, hostEntry) {
    return {
        STARLING_PI_SDK_HOST: hostEntry,
        STARLING_PI_SDK_NODE: nodeExecutable,
    };
}
function parseNodeVersion(version) {
    const match = version.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match)
        return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
export function nodeSupportsBundledPi(version) {
    const actual = parseNodeVersion(version);
    const minimum = parseNodeVersion(MINIMUM_BUNDLED_PI_NODE_VERSION);
    if (!actual || !minimum)
        return false;
    for (let index = 0; index < actual.length; index += 1) {
        if (actual[index] !== minimum[index])
            return actual[index] > minimum[index];
    }
    return true;
}
/**
 * Pi publishes `rpc-entry` and the executable `cli.js` as siblings in dist/.
 * Resolve the public export first, then derive the executable without reaching
 * through package-manager-specific node_modules layouts.
 */
export function piCliPathFromRpcEntry(rpcEntryPath) {
    return path.join(path.dirname(rpcEntryPath), "cli.js");
}
export function piRpcEntryExportTarget(packageJson) {
    if (!packageJson || typeof packageJson !== "object")
        return null;
    const exports = packageJson.exports;
    if (!exports || typeof exports !== "object")
        return null;
    const rpcEntry = exports["./rpc-entry"];
    if (typeof rpcEntry === "string")
        return rpcEntry;
    if (!rpcEntry || typeof rpcEntry !== "object")
        return null;
    const target = rpcEntry.import;
    return typeof target === "string" ? target : null;
}
