# ADR 0001: Chat transport for new chats

Status: Accepted (Phase 4, 2026-10-15)

## Context

EvaOS Electron must start new chats and keep live ones streaming. The Rust app launches an omp child per chat. Relay and herdr can also host sessions, but Relay lives outside this repo and is read-only for this project, and a herdr hop adds a second process boundary on the hottest path (token streaming).

## Decision

- A new chat starts through a direct `omp --mode rpc-ui` child, owned by `SessionManager` behind the `ChatTransport` interface. No `--resume` is passed. The first `get_state` response reports the session file omp created; the pane binds to it, the owner is registered, and the tab place moves from `draft` to that file.
- Every prompt carries the `<surface><machine> - Relay Desktop</surface>` tag (`- EvaOS` before 2026-10-27; both are stripped for display), applied once in `SessionManager.send`.
- The Claude Code harness is a second `ChatTransport` (`bun .claude/bridge/session.ts --rpc`), chosen from `chat.json` at the moment a chat starts. It speaks the same frames, so the reducer, batcher and renderer are shared.
- Closing a chat ends stdin and waits; the app never signals a child (single writer, no destructive use of live sessions).
- Renaming a chat this app does not own uses the short resume (`--mode rpc --resume <file>` with the extras off), as the Rust app does.

## Consequences

- One process per live chat, crash isolation per chat, and the same argv and framing the Rust app uses.
- Sessions started elsewhere (Relay-observed, Eregon sharing) are not controlled here. They are deferred to Phases 6 and 7.
- Fakes (`EVAOS_OMP_BIN`, `EVAOS_CLAUDE_BRIDGE_BIN`) stand in for both transports in tests, so no test attaches to a live session.

## Alternatives

- herdr plus Relay as the session host: rejected for this phase. Relay is read-only and outside this repo, and routing tokens through it adds latency and a failure mode with no parity benefit.
- A Rust sidecar that owns omp children: rejected. The transport is a thin stdio JSON-lines pipe that TypeScript already handles, and a sidecar would add a build target for no gain.
