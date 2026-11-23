# Add the Deepgram call XState machine

Status: COMPLETE
Review Mode: AUTO
Depends on: None
Expected production LOC: 110
Maximum production LOC: 125
Expected files touched: 4

## For Isaac

- Outcome: One XState machine owns the new Deepgram call's lifecycle, with a generated state-machine doc page.
- Why it matters: Single cleanup path, no flag soup (AC8, AC9), as the repo convention requires.
- Proof: Machine tests show hang-up, socket loss, provider drop, failed start and cap each reach one terminal state once; the docs test passes.

## Why

Per your instruction the new Deepgram lifecycle is XState; `LiveCall` and `VoiceCall` are not rewritten. The thread bridge lives in 04, not here.

## Implement

- `apps/linux/src/call/deepgramCall.machine.ts`: `setup()` machine like `meetings/key-moments.machine.ts` (`SessionClock` via `ActorOptions.clock`). States: connecting, listening, hearing, thinking, speaking, ended. Events: provider ready/failed/dropped, user started/stopped, turn delivered/settled, hang-up, socket lost, cap. Owns start timeout, cap (`MAX_LIVE_CALL_MS`), barge-in generation, one cleanup action. One `fromCallback` provider-actor slot.
- `deepgramCall.machine.test.ts` with `SimulatedClock`/`waitFor`/`can()`; register in `machine-docs.test.ts` `MACHINES`; generate `docs/state-machines/deepgram-call.md`.

## Do Not

- No Effect import in the machine file; no refactor of `VoiceCall`/`LiveCall`; no generic provider interface.

## Open Questions

### Q1: Machine scope
Type: ARCHITECTURE
Importance: HIGH
Answer Format: SINGLE_SELECT
Options:
- Deepgram call only
- Also rewrite the GPT-Live and local call lifecycles on XState (rejected)
Comment: Settled by Isaac's 2026-11-23 instruction: XState for the new Deepgram lifecycle, no rewrite of GPT/local lifecycles for DI.
Agent Default: Deepgram call only.
Status: HUMAN_DECIDED
Decision: Deepgram call only.

## Verify

- `deepgramCall.machine.test.ts` and `machine-docs.test.ts` pass; page generated.
