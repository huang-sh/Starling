# Starling Agent

Starling Agent is a VS Code sidebar for browsing, resuming, and organizing Claude Code and OpenAI Codex sessions.

It works with the Starling CLI and shows your local agent history in three focused views: Catalog, Projects, and Sessions.

## Requirements

Install the Starling CLI first:

```bash
npm install -g starling-ai
```

Then make sure VS Code can find the `starling` command:

```bash
starling --help
```

If VS Code cannot find `starling` on `PATH`, set `starling.cliPath` to an absolute executable path in VS Code settings.

## Views

### Catalog

Browse hierarchical Starling catalogs and the sessions assigned to them.

Right-click a catalog session to:

- Resume the session.
- Show session details.
- Open the session project in a new VS Code window.
- Copy the project path.
- Copy the session ID.
- Remove pin metadata.
- Delete the session.

Right-click a catalog folder to:

- Rename the catalog.
- Delete the catalog without deleting session files.

### Projects

Browse projects as a directory tree with session counts.

Right-click a project to:

- Show project details.
- Open the project in a new VS Code window.
- Copy the project path.

Project session nodes support the same session actions as the Sessions view.

### Sessions

Browse recent Claude Code and Codex sessions with incremental loading.

Right-click a session to:

- Resume the session.
- Show session details.
- Pin it to a catalog.
- Open its project in a new VS Code window.
- Copy the project path.
- Copy the session ID.
- Remove pin metadata.
- Delete the session.

## Commands

Open the Command Palette and search for `Starling`.

Common commands:

- `Starling: Refresh`
- `Starling: Resume Session`
- `Starling: Show Session Details`
- `Starling: Pin Session`
- `Starling: Pin to Catalog`
- `Starling: Remove Pin`
- `Starling: Delete Session`
- `Starling: List Sessions`
- `Starling: Session Index Status`
- `Starling: Rebuild Session Index`
- `Starling: List Models`
- `Starling: Rename Catalog`
- `Starling: Delete Catalog`
- `Starling: Catalog Tree`
- `Starling: List Projects`
- `Starling: Open Project in New Window`
- `Starling: Copy Project Path`
- `Starling: Copy Session ID`

## Settings

```json
{
  "starling.cliPath": "starling",
  "starling.cacheTtlSeconds": 30,
  "starling.projectSessionLimit": 30,
  "starling.sessionTreeLimit": 50
}
```

### `starling.cliPath`

Path to the Starling CLI executable. Use an absolute path if the VS Code extension host cannot find `starling` on `PATH`.

### `starling.cacheTtlSeconds`

How long CLI query results are cached. Set to `0` to disable cache.

### `starling.projectSessionLimit`

Number of sessions shown per project node before requiring "Load more". Set to `0` to show all.

### `starling.sessionTreeLimit`

Number of sessions loaded per batch in the Sessions view. Set to `0` to load all.

## Local Data

Starling stores metadata and indexes under:

```text
~/.starling/
```

The extension reads this data through the Starling CLI. It does not upload session contents.

## Useful CLI Commands

```bash
starling session ls
starling session show <session-id>
starling session index status
starling session index rebuild
starling catalog tree
starling project ls
starling model ls
```

## Repository

https://github.com/huang-sh/Starling
