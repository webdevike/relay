# State machines: make impossible states impossible

Convention (Isaac, 2026-11-11): non-trivial state in Relay (desktop, mobile, packages, host) is an
XState v5 machine. The machine names every state and every event, so contradictory combinations
(sending and timed out, a call on a stale socket epoch, reloading mid-send) cannot be represented.

## When

Use a machine for: lifecycles with 3+ states; async work with timeouts, retries, backoff or cancel;
connections, sockets, calls and audio sessions; uploads; multi-step flows (asks and approvals, OTA
and reload gates, onboarding); any place two or more booleans must not be true together.

Skip it for a single toggle, a controlled input, a trivial form, derived values or server cache.

## How

- **Files**: the machine sits next to its feature, `src/<feature>/<name>.machine.ts` with
  `<name>.machine.test.ts` beside it (a folder named for the machine may use `machine.ts`, as
  `apps/mobile/src/dictation/` does). The machine file is pure: `xstate` and types only.
- **Typing**: always `setup({ types, actions, guards, actors, delays }).createMachine(...)`. Events
  are a discriminated union named `domain.event` (`upload.cancel`, `socket.closed`).
- **Effects**: network, native modules, timers and listeners are actors (`fromPromise`,
  `fromCallback`, invoked on the state that owns them) or named actions. A runtime file (`actor.ts`)
  provides the real implementations with `machine.provide(...)`; tests provide stubs. Components
  render from state and send events; no effect logic in components.
- **Tests**: pure machine tests with stubbed actors, `SimulatedClock` for time, `waitFor` for async,
  `snapshot.can(event)` to prove an impossible transition is refused. No UI needed.
- **React / React Native**: `useActorRef` + `useSelector` (selectors defined outside the component)
  for shared or busy machines; `useMachine` only for small local ones. App-lifetime machines are one
  module-level actor read through `useSelector`.
- **Native (Swift/Kotlin)**: the same rule as an explicit state enum with transitions in one place,
  plus the same docs page.

## Docs: `docs/state-machines/`

Every machine has `docs/state-machines/<name>.md` so a person can read it without reading XState:

- a one-line summary of what the machine is for;
- a Mermaid `stateDiagram-v2` **generated from the machine definition** (states, events, guards,
  delays), never hand-drawn;
- one plain-English line per state that is not self-explanatory.

A docs test regenerates every diagram from its machine and fails when a page is stale, so the
picture always matches the code. Changing a machine means regenerating its page, rereading the
diagram and updating the prose in the same commit.

Phone (apps/mobile): the generator is `src/lib/machineDiagram.ts` and the test
`src/machineDocs.test.ts` (add each machine to its `MACHINES` list); `pnpm machines:docs` rewrites
the diagrams and starts a page for a new machine with a TODO the test refuses until it is replaced.
Swift machines draw from their transition table: `pnpm test:native` checks
`live-call-lifecycle.md`, and `UPDATE_MACHINE_DOCS=1 pnpm test:native` rewrites it.

## Migrating flag soup

1. List every flag, ref and timer the feature uses and where each is set and read.
2. Write a states table: one row per real situation, the events that leave it and where they go.
   Flag combinations with no row are the bugs being fixed; note them.
3. Port the current behavior and those bugs into `.machine.test.ts` cases first.
4. Write the machine until they pass; generate its docs page.
5. Swap the component over to `matches` and events and delete the old flags, refs and timers in the
   same change.

Full guide with examples (Eva agents): `skill://xstate` (`~/Eva/.omp/skills/xstate/SKILL.md`).
