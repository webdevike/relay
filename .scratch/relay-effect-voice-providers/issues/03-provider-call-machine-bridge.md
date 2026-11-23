# Add the provider-call XState machine

Status: PLANNED
Review Mode: AUTO
Depends on: None
Expected production LOC: 110
Maximum production LOC: 160
Expected files touched: 4

## For Isaac

- Outcome: One XState machine owns a Deepgram call's lifecycle, with a generated state-machine doc page.
- Why it matters: It gives the call a single cleanup path and keeps timers and states out of ad-hoc flags (AC7, AC8).
- Proof: Machine tests show hang-up, socket loss, provider drop, failed start and the cap each reach one terminal state once; `docs/state-machines/provider-call.md` exists and the docs test passes.

## Why

Plan review removed the separate `threadBridge.ts`: it would have a single consumer (a shared module with one user is not shared). The turn-bridge logic lives in `deepgramCall.ts` (issue 04), copied in shape from `VoiceCall`/`LiveCall` and not refactored into them. This issue is the lifecycle machine only (AC7, AC8).

## Implement

- `apps/linux/src/call/providerCall.machine.ts`: `setup()` machine following `meetings/key-moments.machine.ts` (`SessionClock` through `ActorOptions.clock`). States: connecting, listening, hearing, thinking, speaking, ended. Events: provider ready/failed/dropped, user started/stopped, turn delivered/settled, hang-up, socket lost, cap. Owns start timeout, cap (`MAX_LIVE_CALL_MS`) and barge-in generation. Terminal state reports once and runs a single cleanup action. One `fromCallback` provider-actor slot (the Effect fiber arrives in issue 04).
- Tests: `providerCall.machine.test.ts` with `SimulatedClock`/`waitFor`/`can()`.
- Register in `apps/linux/test/machine-docs.test.ts` `MACHINES`; generate `docs/state-machines/provider-call.md`.

## Do Not

- Do not refactor `VoiceCall` or `LiveCall` onto the machine.
- Do not add a shared thread-bridge module (single consumer; lives in issue 04).
- Do not import Effect in the machine file.
- Do not add a generic provider interface.

## Open Questions

### Q1: Machine scope for AC8
Type: ARCHITECTURE
Importance: HIGH
Answer Format: SINGLE_SELECT
Options:
- New machine drives the Deepgram call only (GPT and local calls untouched)
- Also migrate `LiveCall` lifecycle onto the machine, guarded by `live.test.ts`
- Migrate both `LiveCall` and `VoiceCall`
Comment: Migrating GPT triples the diff and risks AC1. With the default, only the Deepgram call runs on the machine; GPT and local calls keep their existing lifecycle code. If Isaac chooses a migration, planning reopens with a new issue.
Agent Default: Deepgram call only.
Status: OPEN
Decision: Pending

## Verify

- `providerCall.machine.test.ts` and `machine-docs.test.ts` pass.
- `docs/state-machines/provider-call.md` is generated and committed.
