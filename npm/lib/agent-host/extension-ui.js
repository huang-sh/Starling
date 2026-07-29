import { randomUUID } from "node:crypto";
import { isJsonObject, } from "./types.js";
/** Create the portable subset of Pi's extension UI used by RPC clients. */
export function createExtensionUiBridge(output) {
    const pending = new Map();
    let editorText = "";
    let lastConfirmationExplicit = false;
    let closed = false;
    const request = (payload, options, fallback, parse, validate, onSettled) => {
        if (closed || options?.signal?.aborted) {
            onSettled?.(undefined);
            return Promise.resolve(fallback);
        }
        const id = randomUUID();
        return new Promise((resolve) => {
            let timer;
            const cleanup = () => {
                if (timer)
                    clearTimeout(timer);
                options?.signal?.removeEventListener("abort", onAbort);
                pending.delete(id);
            };
            const finish = (value, response) => {
                cleanup();
                if (!response && !closed)
                    output({ type: "extension_ui_cancelled", id });
                onSettled?.(response);
                resolve(value);
            };
            const onAbort = () => finish(fallback);
            options?.signal?.addEventListener("abort", onAbort, { once: true });
            if (options?.timeout !== undefined && options.timeout > 0) {
                timer = setTimeout(() => finish(fallback), options.timeout);
            }
            pending.set(id, {
                cancel: () => finish(fallback),
                resolve: (response) => {
                    if (!validate(response))
                        return false;
                    finish(parse(response), response);
                    return true;
                },
            });
            output({ type: "extension_ui_request", id, ...payload });
        });
    };
    const emit = (payload) => {
        if (closed)
            return;
        output({ type: "extension_ui_request", id: randomUUID(), ...payload });
    };
    const plainTheme = new Proxy({}, {
        get: () => (...args) => String(args.at(-1) ?? ""),
    });
    const context = {
        select: (title, options, dialogOptions) => request({ method: "select", title, options, timeout: dialogOptions?.timeout }, dialogOptions, undefined, (response) => response.cancelled ? undefined : response.value, isCancelledOrString),
        confirm: (title, message, dialogOptions) => request({ method: "confirm", title, message, timeout: dialogOptions?.timeout }, dialogOptions, false, (response) => response.cancelled ? false : response.confirmed === true, (response) => response.cancelled === true || typeof response.confirmed === "boolean", (response) => {
            lastConfirmationExplicit = response?.cancelled !== true
                && typeof response?.confirmed === "boolean";
        }),
        input: (title, placeholder, dialogOptions) => request({
            method: "input",
            title,
            placeholder,
            message: dialogOptions?.message,
            secret: dialogOptions?.secret === true,
            timeout: dialogOptions?.timeout,
        }, dialogOptions, undefined, (response) => response.cancelled ? undefined : response.value, isCancelledOrString),
        editor: (title, prefill) => request({ method: "editor", title, prefill }, undefined, undefined, (response) => response.cancelled ? undefined : response.value, isCancelledOrString),
        notify: (message, notifyType) => emit({ method: "notify", message, notifyType }),
        setStatus: (statusKey, statusText) => emit({ method: "setStatus", statusKey, statusText }),
        setWidget: (widgetKey, content, options) => {
            if (content === undefined || (Array.isArray(content) && content.every((line) => typeof line === "string"))) {
                emit({
                    method: "setWidget",
                    widgetKey,
                    widgetLines: content,
                    widgetPlacement: options?.placement,
                });
            }
        },
        setTitle: (title) => emit({ method: "setTitle", title }),
        setEditorText: (text) => {
            editorText = text;
            emit({ method: "set_editor_text", text });
        },
        pasteToEditor: (text) => {
            editorText += text;
            emit({ method: "set_editor_text", text: editorText });
        },
        getEditorText: () => editorText,
        onTerminalInput: () => () => { },
        setWorkingMessage: () => { },
        setWorkingVisible: () => { },
        setWorkingIndicator: () => { },
        setHiddenThinkingLabel: () => { },
        setFooter: () => { },
        setHeader: () => { },
        custom: async () => undefined,
        addAutocompleteProvider: () => { },
        setEditorComponent: () => { },
        getEditorComponent: () => undefined,
        theme: plainTheme,
        getAllThemes: () => [],
        getTheme: () => undefined,
        setTheme: () => ({ success: false, error: "Theme switching is not supported by the Starling host" }),
        getToolsExpanded: () => false,
        setToolsExpanded: () => { },
    };
    return {
        context,
        handleResponse(value) {
            if (!isJsonObject(value) || value.type !== "extension_ui_response" || typeof value.id !== "string") {
                return false;
            }
            const interaction = pending.get(value.id);
            if (!interaction)
                return false;
            return interaction.resolve(value);
        },
        wasLastConfirmationExplicit() {
            return lastConfirmationExplicit;
        },
        cancelAll() {
            closed = true;
            for (const interaction of [...pending.values()])
                interaction.cancel();
            pending.clear();
        },
    };
}
function isCancelledOrString(response) {
    return response.cancelled === true || typeof response.value === "string";
}
