---
name: starling-agent-session
description: Use when working with Starling, the local agent session manager for Claude Code and Codex: organizing sessions into catalogs, managing projects/session, launching agents with catalog assignment, configuring Claude/Codex profiles.
---

# Starling

Starling is a local session manager for Claude Code and Codex. It discovers session files, groups sessions by project, organizes them into catalogs, stores metadata under `~/.starling`, and provides a VS Code sidebar.


## Catalogs

Use one plain catalog name in examples unless explaining hierarchy:

```bash
starling catalog create paper-review
starling catalog add paper-review <session-id> --title "Figure review"
starling catalog tree
starling catalog show paper-review
```

Hierarchy is path-based:

```bash
starling catalog create research/paper
starling catalog create child --parent research
```

`research/paper` means catalog `paper` under parent catalog `research`; it is not a single catalog name.

Useful catalog operations:

```bash
starling catalog ls
starling catalog show <catalog>
starling catalog detach <catalog> <session-id>
starling catalog clear <catalog>
starling catalog rename <catalog> <new-name>
starling catalog delete <catalog>
```

Deleting a catalog recursively deletes child catalogs from Starling metadata. It does not delete real session files.

## Sessions

Common session commands:

```bash
starling session ls
starling session ls --all
starling session ls --cataloged
starling session ls --catalog paper-review
starling session show <session-id>
starling resume <session-id>
```

Manage catalog assignment from the session namespace:

```bash
starling session catalog add <session-id> paper-review --title "Important run"
starling session catalog remove <session-id> paper-review
starling session catalog clear <session-id>
```

Use 13-character session ID display when changing UI or tables, unless full IDs are required.

## Projects And Index

Project views are built from the local session index by default:

```bash
starling project ls
starling project ls --all
starling project show /path/to/project
starling session index status
starling session index rebuild
starling session index clear
```

If project output is stale, rebuild the index. If performance is being investigated, compare indexed and scan modes:

```bash
starling project ls --refresh-index
starling project ls --no-index
```

## Running Agents

Starling arguments go before the agent name. Agent arguments go after the agent name and should be passed through unchanged:

```bash
starling run --catalog paper-review codex
starling run --catalog paper-review codex exec "summarize this repo"
starling run --config ds --catalog paper-review claude
starling run --catalog paper-review claude --dangerously-skip-permissions
```

If `--config` is omitted, Starling should use the agent's normal default configuration and must not overwrite default Codex or Claude config files.

## Model Profiles

Profiles live under:

```text
~/.starling/settings/claude/<name>.json
~/.starling/settings/codex/<name>.json
```

List profiles:

```bash
starling model ls
starling model ls --agent claude
starling model ls --agent codex
```

Create profiles:

```bash
starling model add ds --agent claude --model deepseek-v4-pro --base-url https://api.example.com --api-key "$API_KEY"
starling model add demo --agent codex --model gpt-5.2 --base-url https://api.example.com/v1 --api-key "$OPENAI_API_KEY" --reasoning high --wire-api responses
```

Codex profiles use JSON with `auth` and `config`. Starling converts them into temporary Codex config for a run.

## VS Code Extension

Extension source is in:

```text
vscode-extension/
```

Compile before claiming extension changes work:

```bash
cd /data20T/dev/Starling/vscode-extension
npm run compile
```

The sidebar has three views in this order:

```text
Catalog
Projects
Sessions
```

The extension calls the `starling` CLI. If VS Code cannot find it, use the install prompt or set `starling.cliPath` to an absolute path.

## Development And Release

For local development:

```bash
cd /data20T/dev/Starling
npm install
npm run build
npm run lint
npm test
npm link
```

For testing the published package:

```bash
npm uninstall -g starling-ai
npm install -g starling-ai
starling --version
```

Publishing uses tags:

```bash
git tag vX.Y.Z
git tag vsx-vX.Y.Z
git push origin vX.Y.Z vsx-vX.Y.Z
```

`vX.Y.Z` triggers npm publish. `vsx-vX.Y.Z` triggers VS Code Marketplace publish. A GitHub Release can include both assets:

```bash
npm pack --pack-destination .
cd vscode-extension && npx @vscode/vsce package
gh release create vX.Y.Z ../starling-ai-X.Y.Z.tgz starling-ai-X.Y.Z.vsix --title "vX.Y.Z" --generate-notes
```

If `gh release create` fails with a 403 while `GITHUB_TOKEN` is set, try:

```bash
env -u GITHUB_TOKEN gh release create ...
```

## Guardrails

- Do not remove or rewrite user data in `~/.starling`, `~/.claude`, or `~/.codex` unless explicitly requested.
- Do not let `starling run --config <name> codex` mutate the user's default `~/.codex/config.toml`.
- Keep examples with a single catalog name unless the task is specifically about hierarchy.
- When changing CLI behavior, update README, tests, and `dist/index.js`.
- When changing extension behavior, update `vscode-extension/package.json` contributions if needed and run `npm run compile`.
