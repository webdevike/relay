# Result: Produce and persist trustworthy settings-form evidence

Status: COMPLETE

## Implemented

- 24 distinct settings-form verification cases, six per category, split 16 development / 8 holdout.
- Real isolated Electron rendering, labels, DOM/Range clipping, keyboard sequence, save/reload observations and before/after PNGs.
- Required adjudicator boundary, frozen public envelopes, protected labels, bounded run lifecycle and cancellation.
- Atomic schema-validated storage, confined evidence delivery, interrupted-run recovery and explicit score denominators.

## Why This Approach

Reuses Electron, PageControl, config-store and typed IPC contracts. No browser dependency, database, fake production evaluator or generic framework. Text observations are model inputs; PNGs are inspectable evidence, not claimed vision judgments.

## Reused

- PageControl fixed measurements and existing inactive-window pattern.
- Existing config-store atomic writes and strict media path confinement.
- Shared Zod contract composition.

## Actual Complexity

- Production LOC added: 1390
- Production LOC deleted: 1
- Test LOC added: 488
- Test LOC deleted: 0
- Files touched: 12

## Budget

- Expected production LOC: 1400
- Maximum production LOC: 1500
- Actual production LOC added: 1390
- Expected files: 12
- Actual files: 12
- Initial unformatted estimate was superseded by the documented format-accounting replan in the parent spec. No feature scope changed.

## Review Callouts

- Requested identity is exact. Returned identity/version may be null when upstream does not report them; never invented.
- Typed safe infrastructure messages remain actionable; unknown exception bodies are not persisted.
- Qualification requires complete matching outcomes on this fixture suite; no production-safety or autonomy claim.

## Open Questions Resolved

- Common track: identical text observations, with real screenshots retained for inspection.
- Sequential bounded execution, explicit denominators, no synthetic verdict fallback.

## Verification

- Four Node-compatible regression files initially passed 16 tests; final full Vitest run passed 1183 tests, zero failures, two native-browser tests skipped under Node.
- Real Jev 1.13 + GPT-5.6 Luna comparison `babc3bbe-397a-45b3-8327-6b1b150f44d2`: 24 collected cases, 48 valid decisions, no infrastructure errors.
- Actual evidence: clean save survived reload; defective save reverted to Default; keyboard-skipped field and clipped control were observed in native Chromium.
- Live CLI timeout and early cancellation persisted terminal non-qualified results. UI start/cancel also exercised with real providers configured.
- Native image inspection and UI/CLI persisted reload passed. Native browser behavior was not inferred from skipped Node tests.
