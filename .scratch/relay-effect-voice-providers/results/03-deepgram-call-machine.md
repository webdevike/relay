# Result: Add the Deepgram call XState machine

## Implemented
- `apps/linux/src/call/deepgramCall.machine.ts`: `deepgramCallMachine` (`setup().createMachine`): `connecting` -> `live.{listening,hearing,thinking,speaking}`, finals `unavailable` (never opened) and `ended`; a `session` actor stub the runtime replaces; `cap` delay = `MAX_LIVE_CALL_MS`; output `{ connected, error }`.
- `test/deepgramCall.machine.test.ts` (9 cases), `test/machine-docs.test.ts` registration, `docs/state-machines/deepgram-call.md` (generated diagram plus plain English).

## Why This Approach
Only the new lifecycle is a machine (Q1). The thread bridge stays in 04's call file, so the machine is states, events and terminal outcomes only.

## Reused
- `meetings/key-moments.machine.ts` pattern (`setup`, `fromX` stub, `SimulatedClock` in tests), `machine-docs.test.ts` generator.

## Actual Complexity
- Production LOC added: 84
- Production LOC deleted: 0
- Test LOC added: 102 (100 + 2 in `machine-docs.test.ts`)
- Files touched: 4

## Budget
- Expected production LOC: 110
- Maximum production LOC: 125 (rebalanced 2026-11-23 from 160 when docs started counting; parent cap unchanged at 1000)
- Actual production LOC: 123 (machine 84 plus the generated `docs/state-machines/deepgram-call.md` 39, which counts since Isaac's 2026-11-23 decision)
- Expected files: 4
- Actual files: 4

## Review Callouts
- Hang-up while `connecting` ends in `ended` with `connected: false`; `unavailable` is only a failed open.
- Events the machine cannot take (`user.speaking` while connecting) are refused (`can()` tested).

## Open Questions Resolved
- Q1 → Deepgram call only (Isaac, 2026-11-23; recorded `HUMAN_DECIDED`).

## Verification
- `npx vitest run test/deepgramCall.machine.test.ts test/machine-docs.test.ts` (apps/linux) — PASS (11 tests; each terminal path stops the session actor once, cap fires at `MAX_LIVE_CALL_MS` not before)
- `UPDATE_MACHINE_DOCS=1` generated the page; test then passes without TODO — PASS
- `npx eslint`, `npx tsc --noEmit` on the new files — PASS
