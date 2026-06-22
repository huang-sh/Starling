export function normalizeMonitorSnapshot(raw) {
    if (Array.isArray(raw)) {
        const rows = raw.map(normalizeMonitorRow);
        const pinned = rows.filter((row) => row.pinned);
        const recent = rows.filter((row) => !row.pinned);
        return {
            schema_version: 1,
            generated_at_ms: Date.now(),
            pinned_total: pinned.length,
            recent_total: recent.length,
            active: rows.filter((row) => isActiveLiveStatus(row.status)).length,
            pinned,
            recent,
        };
    }
    const obj = isRecord(raw) ? raw : {};
    const pinned = Array.isArray(obj.pinned) ? obj.pinned.map(normalizeMonitorRow) : [];
    const recent = Array.isArray(obj.recent) ? obj.recent.map(normalizeMonitorRow) : [];
    const rows = [...pinned, ...recent];
    return {
        schema_version: toNumber(obj.schema_version, 1),
        generated_at_ms: toNumber(obj.generated_at_ms, Date.now()),
        pinned_total: toNumber(obj.pinned_total, pinned.length),
        recent_total: toNumber(obj.recent_total, recent.length),
        active: toNumber(obj.active, rows.filter((row) => isActiveLiveStatus(row.status)).length),
        pinned,
        recent,
    };
}
export function normalizeMonitorRow(raw) {
    const row = isRecord(raw) ? raw : {};
    const memKb = toNumber(row.mem_kb ?? row.rss_kb, 0);
    return {
        session_id: String(row.session_id ?? ""),
        pinned: Boolean(row.pinned),
        catalog: typeof row.catalog === "string" ? row.catalog : undefined,
        title: String(row.title ?? ""),
        provider: String(row.provider ?? ""),
        model: String(row.model ?? ""),
        status: normalizeLiveStatus(row.status),
        pid: typeof row.pid === "number" ? row.pid : undefined,
        cpu_pct: toNumber(row.cpu_pct, 0),
        mem_kb: memKb,
        rss_kb: typeof row.rss_kb === "number" ? row.rss_kb : undefined,
        ctx_pct: toNumber(row.ctx_pct, -1),
        tokens_in: toNumber(row.tokens_in, 0),
        tokens_out: toNumber(row.tokens_out, 0),
        tokens_cache: toNumber(row.tokens_cache, 0),
        last_tool: typeof row.last_tool === "string" && row.last_tool ? row.last_tool : null,
        tool_count: toNumber(row.tool_count, 0),
        project_path: String(row.project_path ?? row.project ?? ""),
        project: String(row.project ?? row.project_path ?? ""),
        file_path: typeof row.file_path === "string" ? row.file_path : undefined,
        last_activity_ms: toNumber(row.last_activity_ms, 0),
        started_at_ms: toNumber(row.started_at_ms, 0),
        elapsed_secs: toNumber(row.elapsed_secs, 0),
        pending_since_ms: toNumber(row.pending_since_ms, 0),
        thinking_since_ms: toNumber(row.thinking_since_ms, 0),
        token_history: Array.isArray(row.token_history) ? row.token_history.map((n) => toNumber(n, 0)) : [],
        context_history: Array.isArray(row.context_history) ? row.context_history.map((n) => toNumber(n, 0)) : [],
        compaction_count: toNumber(row.compaction_count, 0),
        current_task: String(row.current_task ?? ""),
        tool_calls_tail: Array.isArray(row.tool_calls_tail) ? row.tool_calls_tail.map(normalizeMonitorToolCall) : [],
        chat_tail: Array.isArray(row.chat_tail) ? row.chat_tail.map(normalizeMonitorChatMessage) : [],
    };
}
export function monitorRows(snapshot) {
    return [...snapshot.pinned, ...snapshot.recent];
}
export function isActiveLiveStatus(status) {
    return status === "waiting" || status === "running";
}
function normalizeLiveStatus(value) {
    const status = String(value ?? "").toLowerCase();
    if (status === "permission" || status === "permission_approval" || status === "approval" || status === "needs_attention")
        return "waiting";
    if (status === "waiting" || status === "waiting_input" || status === "waiting_for_input")
        return "waiting";
    if (status === "busy" || status === "thinking" || status === "executing" || status === "rate_limited")
        return "running";
    if (status === "stale_running" || status === "stale-running" || status === "running_stale" || status === "running-stale")
        return "stale_running";
    if (status === "aborted" || status === "abort" || status === "interrupted" || status === "interrupt" || status === "cancelled" || status === "canceled" || status === "terminated")
        return "aborted";
    if (status === "idle")
        return "idle";
    if (status === "running")
        return "running";
    if (status === "failure" || status === "failed" || status === "error")
        return "failure";
    if (status === "stopped" || status === "done")
        return "stopped";
    return "unknown";
}
function normalizeMonitorToolCall(raw) {
    const row = isRecord(raw) ? raw : {};
    return {
        name: String(row.name ?? ""),
        arg: String(row.arg ?? ""),
        duration_ms: toNumber(row.duration_ms, 0),
    };
}
function normalizeMonitorChatMessage(raw) {
    const row = isRecord(raw) ? raw : {};
    return {
        role: row.role === "assistant" ? "assistant" : "user",
        text: String(row.text ?? ""),
    };
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function toNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
