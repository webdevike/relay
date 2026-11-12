# Relay

Repo-wide rules for agents. Each app has its own notes too: `apps/mobile/AGENTS.md`,
`apps/desktop/AGENTS.md`.

## State machines (Isaac, 2026-11-11)

Make impossible states impossible: non-trivial state (3+ states, async with timeouts, retries or
cancel, connections, calls, uploads, multi-step flows, boolean-flag soup) is an XState v5 machine in
`<name>.machine.ts` with pure tests beside it and a page in `docs/state-machines/<name>.md` (generated
Mermaid diagram plus plain English, kept in sync by a docs test). Rules and migration recipe:
`docs/conventions/state-machines.md`.
