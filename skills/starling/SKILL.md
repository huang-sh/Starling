---
name: starling-ai-agent
description: "Use when working with Starling: launch, switch, and organize Claude Code, Codex, and Pi sessions with model profiles, catalogs, project views, live monitoring, and VS Code integration."
---

# Starling

Starling launches, switches, and organizes Claude Code, Codex, and Pi sessions with model profiles, catalogs, project views, live monitoring, and VS Code integration. Use it to start agent runs, resume prior sessions, group important sessions into catalogs, inspect project history, and check live session state.

This skill is an operating manual for agents using Starling. Do not treat it as Starling development or release documentation.

## Agent Rules

- Prefer `starling` CLI commands over manually reading `~/.starling`, `~/.claude`, `~/.codex`, or `~/.pi`.
- Do not delete sessions, remove catalog assignments, or edit model profiles unless the user explicitly asks.
- Do not rewrite agent-owned data under `~/.claude`, `~/.codex`, or `~/.pi`.
- Use one plain catalog name in examples unless the task is specifically about catalog hierarchy.
- Put Starling options before the agent name in `starling run`; pass agent-native arguments after `claude`, `codex`, or `pi`.
- Use bare `starling` for the interactive workspace. It launches Pi's TUI (branded "Starling") through the managed `starling run pi` path.
- Use `starling chat pi` only when acting as a machine client; its stdin and stdout are a JSONL protocol, not an interactive terminal.

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

When the user asks to operate on the current running session, first check the agent-specific environment.

For Codex:

```bash
echo "$CODEX_THREAD_ID"
```

If `CODEX_THREAD_ID` is set, treat it as the current Codex session/thread ID:

```bash
starling session show "$CODEX_THREAD_ID"
starling catalog add paper-review "$CODEX_THREAD_ID" --title "Current session"
```

Do not guess the current session from `starling session ls`, recent file mtimes, or the latest rollout file when `CODEX_THREAD_ID` is available. Recent sessions may belong to unrelated running agents or benchmarks.

For Pi, check both the session ID and the exact transcript path:

Pi injects `PI_SESSION_ID` and `PI_SESSION_FILE` into its LLM-callable bash tool environment. They are not general environment variables on the parent Pi process or user `!`/`!!` shell commands.

```bash
printf 'id=%s\nfile=%s\n' "$PI_SESSION_ID" "$PI_SESSION_FILE"
```

If `PI_SESSION_ID` is set, treat it as the current Pi session ID. `PI_SESSION_FILE`, when set, is the authoritative transcript path:

```bash
starling session show "$PI_SESSION_ID"
starling catalog add paper-review "$PI_SESSION_ID" --title "Current session"
```

If the relevant environment variable is not set, say that the current session ID is not directly exposed and ask the user for the session ID or another reliable identifier. Do not silently pick the newest session.

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
starling project ls --agent pi
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

## Live Monitor

Use `top` for current session state. It shows the top 20 active pinned and unpinned sessions by default; `run status` is only for launch/run records.

```bash
starling top
starling top --watch
starling top --pinned
starling top --limit 40
starling top --agent codex
starling top --agent claude --sort cpu
starling top --agent pi
starling top --sort tokens
starling top --sort cpu
starling top --catalog paper-review
starling top --json
```

Top supports `--agent claude`, `--agent codex`, and `--agent pi`.

Top sort modes are `activity` (default), `recent`, `tokens`, `created`, `memory`, `cpu`, `ctx`, `skills`, and `tools`.

Treat `running`, `waiting`, `idle`, `aborted`, `failure`, and `stopped` as session state, not just process state.

## Data Directory

Starling uses `~/.starling` by default for metadata, model profiles, and session indexes. Prefer the CLI setting when the user wants to persist a different location:

```bash
starling config set home /data20T/dev/.starling --migrate
starling config show
```

`--migrate` copies existing Starling metadata into the new home without overwriting target files. `STARLING_HOME=/path` can still be used for one-off commands and overrides the saved CLI setting for that process.

## Running Agents

Starling arguments go before the agent name. Agent arguments go after the agent name. Managed Pi runs may additionally inject runtime hooks/session IDs and pin a dynamic session selector to the exact locked transcript path.

```bash
starling run -c paper-review codex
starling run -c paper-review codex exec "summarize this repo"
starling run --setting ds -c paper-review claude
starling run --catalog paper-review claude --dangerously-skip-permissions
starling run -c paper-review pi
starling run --catalog paper-review pi --provider anthropic --model claude-sonnet-4-5
```

If `--setting` is omitted, Starling uses the agent's normal default configuration.
`-c` is the short alias for `--catalog`.

Pi does not expose a built-in MCP configuration contract. Do not use Starling's `--mcp` or `--mcp-profile` options with `pi`; use a user-configured Pi extension when MCP integration is required.

A plain `starling run pi` passes no session selector; Pi creates the ID and Starling records it through the runtime hook. Pi features that explicitly use `--session-id` require Pi 0.76 or newer (`pi --version`).

Use `starling run pi --continue` for the current project's latest Pi session. Starling pins an existing target to its absolute transcript path; if none exists, it creates a new session with a preallocated locked ID. Do not use the interactive Pi `--resume` picker through `starling run`: Starling rejects it because the selected transcript cannot be locked before launch. Use `starling resume <session-id-or-absolute-path>` instead. Managed Pi runs also block in-process `/new`, `/resume`, and `/fork`; exit Pi before starting or resuming another managed session.

For managed `starling run pi --session <path>`, require an existing non-empty valid Pi transcript; legacy v1/v2 transcripts are allowed. Missing and zero-byte explicit paths are a deliberate managed limitation because they have no session ID to lock before spawn. Create new managed sessions with `--session-id`, or initialize the exact path with Pi directly before handing it to Starling.

On Linux, prefer managed launches when an active Pi using a one-shot `--session` or `--session-dir` must be mapped reliably. Native Pi replaces its process command line with `pi` after startup, so an externally launched process no longer exposes those one-shot values; persist custom roots through `PI_CODING_AGENT_SESSION_DIR` or `settings.json` when launching Pi outside Starling.

For an editor or another machine client, put Starling options before `pi` and start the RPC transport with:

```bash
starling chat --cwd /path/to/project --catalog paper-review --title "Review" pi
starling chat --cwd /path/to/project pi --session /absolute/path/to/session.jsonl
```

`starling chat pi` starts Starling's Node SDK Host, which directly imports Pi's public session APIs; it never launches `pi --mode rpc`. A new chat deliberately passes no session selector and no `--session-id`; `SessionManager.create()` owns the identity, while resuming requires an absolute transcript path. Stdout is strict LF-delimited JSON: `starling_started` and `starling_exited` records use `schema: "starling.chat"` and `schemaVersion: 1`; the current compatibility records between them retain the established chat command/event shapes. Treat all stderr as diagnostics. Chat disables discovered user/project Pi extensions and explicitly loads only Starling's runtime gate, so custom tools cannot shadow an auto-allowed built-in name. Read-only `read`, `grep`, `find`, and `ls` calls are auto-allowed. Every other tool needs an `extension_ui_response`; deny, cancellation, UI errors, and a 30-second response timeout fail closed. This gate does not apply to ordinary `starling run pi`.

The npm distribution requires Node 22.19.0 or newer and installs the Pi SDK with the range `>=0.82.0` (not pinned to one release). The wrapper supplies `STARLING_PI_SDK_HOST` and `STARLING_PI_SDK_NODE` for bare `starling` and `starling chat pi`. The separate legacy Pi executable precedence for `starling run pi` remains `STARLING_PI_BIN`, `starling config set pi <path>`, `STARLING_BUNDLED_PI_BIN`, then `pi` on `PATH`. Use `starling config show` to inspect the legacy CLI path, launcher, and source.

To put a run into a nested catalog, use a catalog path:

```bash
starling run --catalog research/paper claude
```

## Model Profiles

Profiles live under:

```text
~/.starling/settings/claude/<name>.json
~/.starling/settings/codex/<name>.toml
~/.starling/settings/pi/<name>.json
```

List profiles:

```bash
starling model ls
starling model ls --agent claude
starling model ls --agent codex
starling model ls --agent pi
```

Create profiles only when the user asks:

```bash
starling model add ds --agent claude --model deepseek-v4-pro --base-url https://api.example.com --api-key "$API_KEY"
starling model add demo --agent codex --model gpt-5.2 --base-url https://api.example.com/v1 --api-key "$OPENAI_API_KEY" --reasoning high --wire-api responses
starling model delete demo --agent codex
starling model delete research --agent pi
```

Codex profiles use Codex-style TOML. For Chat Completions-only providers, add `api_format = "openai_chat"`.

Pi profiles are JSON with `provider`, `model`, and optional `thinking` fields. Starling translates them to Pi's `--provider`, `--model`, and `--thinking` arguments for the run. Pi authentication remains in Pi-owned auth/config files such as `~/.pi/agent/auth.json` and `~/.pi/agent/models.json`, or in provider environment variables; do not copy credentials into a Starling Pi profile.

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "thinking": "high"
}
```

## VS Code Extension

The Starling VS Code extension exposes Catalog, Projects, Models, and Monitor views. It calls the local `starling` CLI and consumes the same JSON outputs as terminal renderers.

If the extension cannot find Starling, install the CLI or set `starling.cliPath` in VS Code settings.
