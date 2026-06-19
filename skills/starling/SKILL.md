---
name: starling-agent-session
description: "Use when working with Starling, the local agent session manager for Claude Code and Codex: organizing sessions into catalogs, managing projects/session, launching agents with catalog assignment, configuring Claude/Codex profiles."
---

# Starling

Starling is a local session manager for Claude Code and Codex. Use it to find prior sessions, resume work, organize sessions into catalogs, inspect projects, and launch Claude/Codex with saved model profiles.

This skill is an operating manual for agents using Starling. Do not treat it as Starling development or release documentation.

## Agent Rules

- Prefer `starling` CLI commands over manually reading `~/.starling`, `~/.claude`, or `~/.codex`.
- Do not delete sessions, remove catalog assignments, or edit model profiles unless the user explicitly asks.
- Do not rewrite agent-owned data under `~/.claude` or `~/.codex`.
- Use one plain catalog name in examples unless the task is specifically about catalog hierarchy.
- Put Starling options before the agent name in `starling run`; pass agent-native arguments after `claude` or `codex`.

## Catalogs

Use catalogs to group important sessions.

```bash
starling catalog ls
starling catalog tree
starling catalog tree --sessions
starling catalog show paper-review
```

Create catalogs:

```bash
starling catalog create paper-review
starling catalog create research/paper
starling catalog create child --parent research
```

`research/paper` means catalog `paper` under parent catalog `research`; it is not a single catalog name.

Add or remove sessions:

```bash
starling catalog add paper-review <session-id> --title "Figure review"
starling catalog detach paper-review <session-id>
starling catalog clear paper-review
```

Rename, move, or delete catalogs:

```bash
starling catalog rename paper-review review
starling catalog move review --parent research
starling catalog move review --root
starling catalog delete review
```

Deleting a catalog recursively deletes child catalogs from Starling metadata. It does not delete real session files.

## Sessions

Find and inspect sessions:

```bash
starling session ls
starling session ls --all
starling session ls --cataloged
starling session ls --catalog paper-review
starling session show <session-id>
starling resume <session-id>
```

### Current Session

When the user asks to operate on the current running Codex session, first check the environment:

```bash
echo "$CODEX_THREAD_ID"
```

If `CODEX_THREAD_ID` is set, treat it as the current Codex session/thread ID:

```bash
starling session show "$CODEX_THREAD_ID"
starling catalog add paper-review "$CODEX_THREAD_ID" --title "Current session"
```

Do not guess the current session from `starling session ls`, recent file mtimes, or the latest rollout file when `CODEX_THREAD_ID` is available. Recent sessions may belong to unrelated running agents or benchmarks.

If `CODEX_THREAD_ID` is not set, say that the current session ID is not directly exposed and ask the user for the session ID or another reliable identifier. Do not silently pick the newest session.

Manage session metadata:

```bash
starling session meta <session-id> --title "New title" --tags review,important
starling session note <session-id> "Follow up on benchmark results"
starling session unpin <session-id>
```

Manage catalog assignment from the session namespace:

```bash
starling session catalog add <session-id> paper-review --title "Important run"
starling session catalog remove <session-id> paper-review
starling session catalog clear <session-id>
```

Use full session IDs for destructive or ambiguous operations. Short session IDs in Starling displays are usually 13 characters.

## Projects

Use project commands to find sessions by working directory:

```bash
starling project ls
starling project ls --all
starling project ls --agent claude
starling project ls --agent codex
starling project show /path/to/project
```

If project or session output appears stale:

```bash
starling session index status
starling session index rebuild
```

Use `--no-index` only when troubleshooting a stale or corrupted index:

```bash
starling project ls --no-index
starling project show /path/to/project --no-index
```

## Data Directory

Starling uses `~/.starling` by default for metadata, model profiles, and session indexes. Prefer the CLI setting when the user wants to persist a different location:

```bash
starling config set home /data20T/dev/.starling --migrate
starling config show
```

`--migrate` copies existing Starling metadata into the new home without overwriting target files. `STARLING_HOME=/path` can still be used for one-off commands and overrides the saved CLI setting for that process.

## Running Agents

Starling arguments go before the agent name. Agent arguments go after the agent name and should be passed through unchanged.

```bash
starling run -c paper-review codex
starling run -c paper-review codex exec "summarize this repo"
starling run --setting ds -c paper-review claude
starling run --catalog paper-review claude --dangerously-skip-permissions
```

If `--setting` is omitted, Starling uses the agent's normal default configuration.
`-c` is the short alias for `--catalog`.

To put a run into a nested catalog, use a catalog path:

```bash
starling run --catalog research/paper claude
```

## Model Profiles

Profiles live under:

```text
~/.starling/settings/claude/<name>.json
~/.starling/settings/codex/<name>.toml
```

List profiles:

```bash
starling model ls
starling model ls --agent claude
starling model ls --agent codex
```

Create profiles only when the user asks:

```bash
starling model add ds --agent claude --model deepseek-v4-pro --base-url https://api.example.com --api-key "$API_KEY"
starling model add demo --agent codex --model gpt-5.2 --base-url https://api.example.com/v1 --api-key "$OPENAI_API_KEY" --reasoning high --wire-api responses
starling model delete demo --agent codex
```

Codex profiles use Codex-style TOML. For Chat Completions-only providers, add `api_format = "openai_chat"`.

## VS Code Extension

The Starling VS Code extension exposes Catalog, Projects, Models, and Sessions views. It calls the local `starling` CLI.

If the extension cannot find Starling, install the CLI or set `starling.cliPath` in VS Code settings.
