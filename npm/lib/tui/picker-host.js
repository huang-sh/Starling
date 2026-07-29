export function asError(value) {
    return value instanceof Error ? value : new Error(String(value));
}
