# Codex App-Server Status Source

Starling should prefer Codex app-server runtime status when it is available
through an existing, public, connectable endpoint. Transcript parsing remains
the portable fallback and must work when the Codex VS Code extension is not
installed or when its app-server is private to the extension process.

## What Codex Exposes

Codex app-server protocol v2 exposes a `ThreadStatus` on every `Thread`:

- `idle`
- `active`
- `systemError`
- `notLoaded`

The `active` status can include `activeFlags`:

- `waitingOnApproval`
- `waitingOnUserInput`

The app-server also emits `thread/status/changed` notifications whenever a
loaded thread changes state after it has been introduced to a client. This is
the same class of signal the Codex VS Code extension can use to keep its UI
stable.

## Mapping To Starling

Starling monitor states should map app-server status as follows:

- `active` with `waitingOnApproval` or `waitingOnUserInput` -> `waiting`
- `active` without waiting flags -> `running`
- `idle` -> `idle`
- `systemError` -> `stopped`
- `notLoaded` -> fall back to transcript/process inference

When this source is used, `status_source` should be `app_server`, and
`status_signal` should be `codex_thread_status`.

## VS Code Codex Constraint

The VS Code Codex extension currently launches `codex app-server` with the
default `stdio://` transport. That channel is owned by the Codex extension
process. A separate process such as Starling cannot attach to that already-open
stdio connection and cannot receive `thread/status/changed` directly.

Starling must not require the Codex VS Code extension to exist, and must not
require changes to Codex or the official Codex extension source code.

For Starling to use app-server status in VS Code scenarios, one of these
already-available access paths must exist:

- Codex app-server is launched with a connectable transport, such as
  `--listen unix://`, and Starling connects to that socket.
- Codex app-server remote control is enabled and Starling connects through that
  endpoint.
- The installed Codex VS Code extension already exposes a public command or API
  returning thread statuses.
- A Starling-owned launcher or wrapper records runtime state when Starling
  starts Codex itself.

If none of these access paths is available, Starling must not attempt to inspect
or modify the Codex extension internals. It should use transcript, process, and
Starling runtime-state fallback rules.

## Source Priority

Status sources should be merged in this order:

1. Starling-owned realtime state, such as `starling top record` or launch-time
   runtime hooks.
2. Codex app-server `ThreadStatus`, only when a public connectable app-server
   endpoint is available.
3. Transcript-derived Codex events, with `idle` treated as a weak hint.
4. Process evidence, including process-tree children and active CPU.
5. `stopped` when no matching process exists.

## Current Fallback Rule

Until app-server status is available, Starling should avoid treating Codex
`task_complete` transcript events as a strong final state. Runtime evidence
such as a pending tool process, thinking activity, or active Codex process CPU
must take priority over transcript `idle` hints.

Codex sessions can contain multiple short tasks inside one long-running
thread. A `task_complete` event only means the current task/turn finished, not
that the whole session is idle. Starling should keep the session in `running`
briefly after `codex_task_complete` so the monitor does not flicker to `idle`
between adjacent tasks.
