import { asError } from "./picker-host.js";
export function authProvidersFromResponse(value) {
    if (!isRecord(value) || !Array.isArray(value.providers))
        return [];
    const providers = [];
    for (const item of value.providers) {
        if (!isRecord(item))
            continue;
        const id = text(item.id);
        const authType = item.authType === "oauth" || item.authType === "api_key"
            ? item.authType
            : undefined;
        if (!id || !authType)
            continue;
        providers.push({
            id,
            name: text(item.name) || id,
            authType,
            methodName: text(item.methodName) || (authType === "oauth" ? "Subscription" : "API key"),
            configured: item.configured === true,
            stored: item.stored === true,
            interactive: item.interactive !== false,
            ...(text(item.source) ? { source: text(item.source) } : {}),
        });
    }
    return providers.sort((left, right) => left.name.localeCompare(right.name)
        || left.id.localeCompare(right.id)
        || left.authType.localeCompare(right.authType));
}
export function visibleAuthProviders(picker) {
    const query = picker.query.trim().toLocaleLowerCase();
    if (!query)
        return picker.providers;
    return picker.providers.filter((provider) => [
        provider.id,
        provider.name,
        provider.methodName,
        provider.authType === "oauth" ? "subscription oauth" : "api key",
    ].some((value) => value.toLocaleLowerCase().includes(query)));
}
export function selectedAuthProvider(picker) {
    return visibleAuthProviders(picker)[picker.selected];
}
function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function handleAuthPickerKey(host, key) {
    const picker = host.state.authPicker;
    if (!picker)
        return;
    if (picker.working) {
        if (key.type === "escape" || key.type === "ctrl-c") {
            host.sendSessionRequest({ type: "abort_authentication" });
        }
        return;
    }
    if (key.type === "escape" || key.type === "ctrl-c") {
        host.dispatch({ type: picker.query ? "auth.query.clear" : "auth.close" });
        return;
    }
    if (key.type === "up") {
        host.dispatch({ type: "auth.select", delta: -1 });
        return;
    }
    if (key.type === "down") {
        host.dispatch({ type: "auth.select", delta: 1 });
        return;
    }
    if (key.type === "page-up" || key.type === "page-down") {
        host.dispatch({ type: "auth.select", delta: key.type === "page-up" ? -8 : 8 });
        return;
    }
    if (key.type === "home" || key.type === "end") {
        const count = visibleAuthProviders(picker).length;
        host.dispatch({
            type: "auth.select",
            delta: key.type === "home" ? -picker.selected : count - picker.selected - 1,
        });
        return;
    }
    if (key.type === "enter") {
        const provider = selectedAuthProvider(picker);
        if (provider)
            void authenticateProvider(host, provider);
        return;
    }
    if (key.type === "backspace") {
        host.dispatch({ type: "auth.query.backspace" });
        return;
    }
    if (key.type === "ctrl-u") {
        host.dispatch({ type: "auth.query.clear" });
        return;
    }
    if (key.type === "text" || key.type === "paste") {
        host.dispatch({ type: "auth.query.append", value: key.value });
    }
}
export async function authenticateProvider(host, provider) {
    const picker = host.state.authPicker;
    if (!host.session || !picker || picker.working || host.closing)
        return;
    if (picker.mode === "login" && !provider.interactive) {
        host.dispatch({
            type: "auth.failed",
            message: `${provider.name} authentication is configured outside Pi`,
        });
        return;
    }
    host.dispatch({ type: "auth.working" });
    try {
        await host.session.request(picker.mode === "login"
            ? { type: "login_provider", provider: provider.id, authType: provider.authType }
            : { type: "logout_provider", provider: provider.id });
        host.dispatch({ type: "auth.close" });
        host.dispatch({
            type: "command.completed",
            message: picker.mode === "login"
                ? provider.authType === "oauth"
                    ? `Logged in to ${provider.name}. Run /model to select one of its models.`
                    : `Saved API key for ${provider.name}. Run /model to select one of its models.`
                : provider.authType === "oauth"
                    ? `Logged out of ${provider.name}`
                    : `Removed stored API key for ${provider.name}. Environment variables and models.json are unchanged.`,
        });
    }
    catch (error) {
        const message = asError(error).message;
        if (/login cancelled/i.test(message)) {
            host.dispatch({ type: "auth.close" });
            host.dispatch({ type: "command.completed", message: "Login cancelled" });
        }
        else {
            host.dispatch({ type: "auth.failed", message });
        }
    }
}
