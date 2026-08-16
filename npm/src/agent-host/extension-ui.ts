import { randomUUID } from "node:crypto";
import {
  ExtensionUiResponse,
  JsonObject,
  isJsonObject,
} from "./types.js";

interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

interface PendingInteraction {
  cancel(): void;
  resolve(response: ExtensionUiResponse): boolean;
}

export interface ExtensionUiBridge {
  context: JsonObject;
  handleResponse(value: unknown): boolean;
  wasLastConfirmationExplicit(): boolean;
  cancelAll(): void;
}

/** Create the portable subset of Pi's extension UI used by RPC clients. */
export function createExtensionUiBridge(
  output: (value: unknown) => void,
): ExtensionUiBridge {
  const pending = new Map<string, PendingInteraction>();
  let editorText = "";
  let lastConfirmationExplicit = false;
  let closed = false;

  const request = <T>(
    payload: JsonObject,
    options: DialogOptions | undefined,
    fallback: T,
    parse: (response: ExtensionUiResponse) => T,
    validate: (response: ExtensionUiResponse) => boolean,
    onSettled?: (response: ExtensionUiResponse | undefined) => void,
  ): Promise<T> => {
    if (closed || options?.signal?.aborted) {
      onSettled?.(undefined);
      return Promise.resolve(fallback);
    }
    const id = randomUUID();

    return new Promise<T>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
        pending.delete(id);
      };
      const finish = (value: T, response?: ExtensionUiResponse): void => {
        cleanup();
        if (!response && !closed) output({ type: "extension_ui_cancelled", id });
        onSettled?.(response);
        resolve(value);
      };
      const onAbort = (): void => finish(fallback);
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (options?.timeout !== undefined && options.timeout > 0) {
        timer = setTimeout(() => finish(fallback), options.timeout);
      }

      pending.set(id, {
        cancel: () => finish(fallback),
        resolve: (response) => {
          if (!validate(response)) return false;
          finish(parse(response), response);
          return true;
        },
      });
      output({ type: "extension_ui_request", id, ...payload });
    });
  };

  const emit = (payload: JsonObject): void => {
    if (closed) return;
    output({ type: "extension_ui_request", id: randomUUID(), ...payload });
  };

  const plainTheme = new Proxy<JsonObject>({}, {
    get: () => (...args: unknown[]) => String(args.at(-1) ?? ""),
  });

  const context: JsonObject = {
    select: (
      title: string,
      options: string[],
      dialogOptions?: DialogOptions,
    ) => request(
      { method: "select", title, options, timeout: dialogOptions?.timeout },
      dialogOptions,
      undefined,
      (response) => response.cancelled ? undefined : response.value,
      isCancelledOrString,
    ),
    confirm: (
      title: string,
      message: string,
      dialogOptions?: DialogOptions,
    ) => request(
      { method: "confirm", title, message, timeout: dialogOptions?.timeout },
      dialogOptions,
      false,
      (response) => response.cancelled ? false : response.confirmed === true,
      (response) => response.cancelled === true || typeof response.confirmed === "boolean",
      (response) => {
        lastConfirmationExplicit = response?.cancelled !== true
          && typeof response?.confirmed === "boolean";
      },
    ),
    input: (
      title: string,
      placeholder?: string,
      dialogOptions?: DialogOptions,
    ) => request(
      { method: "input", title, placeholder, timeout: dialogOptions?.timeout },
      dialogOptions,
      undefined,
      (response) => response.cancelled ? undefined : response.value,
      isCancelledOrString,
    ),
    editor: (title: string, prefill?: string) => request(
      { method: "editor", title, prefill },
      undefined,
      undefined,
      (response) => response.cancelled ? undefined : response.value,
      isCancelledOrString,
    ),
    notify: (message: string, notifyType?: "info" | "warning" | "error") =>
      emit({ method: "notify", message, notifyType }),
    setStatus: (statusKey: string, statusText?: string) =>
      emit({ method: "setStatus", statusKey, statusText }),
    setWidget: (
      widgetKey: string,
      content: unknown,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ) => {
      if (content === undefined || (Array.isArray(content) && content.every((line) => typeof line === "string"))) {
        emit({
          method: "setWidget",
          widgetKey,
          widgetLines: content,
          widgetPlacement: options?.placement,
        });
      }
    },
    setTitle: (title: string) => emit({ method: "setTitle", title }),
    setEditorText: (text: string) => {
      editorText = text;
      emit({ method: "set_editor_text", text });
    },
    pasteToEditor: (text: string) => {
      editorText = text;
      emit({ method: "set_editor_text", text });
    },
    getEditorText: () => editorText,
    onTerminalInput: () => () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setFooter: () => {},
    setHeader: () => {},
    custom: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: plainTheme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is not supported by the Starling host" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  return {
    context,
    handleResponse(value: unknown): boolean {
      if (!isJsonObject(value) || value.type !== "extension_ui_response" || typeof value.id !== "string") {
        return false;
      }
      const interaction = pending.get(value.id);
      if (!interaction) return false;
      return interaction.resolve(value as ExtensionUiResponse);
    },
    wasLastConfirmationExplicit(): boolean {
      return lastConfirmationExplicit;
    },
    cancelAll(): void {
      closed = true;
      for (const interaction of [...pending.values()]) interaction.cancel();
      pending.clear();
    },
  };
}

function isCancelledOrString(response: ExtensionUiResponse): boolean {
  return response.cancelled === true || typeof response.value === "string";
}
