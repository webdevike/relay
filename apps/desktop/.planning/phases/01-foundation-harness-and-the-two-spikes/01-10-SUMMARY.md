---
phase: 01-foundation-harness-and-the-two-spikes
plan: 10
subsystem: proof
tags: [proof, metrics, packaging, electron-builder, drag-region, gate]
requires: [01-06, 01-09]
provides:
  - proof/phase-1 composite screenshots with paired assertions and validated metrics.json
  - scripts/check-metrics.ts validator
  - electron-builder dir build (identity null, arm64) with a packaged smoke spec
  - os-drag.swift and drag-region spec
  - HUMAN-CHECKS.md ledger
key-files:
  created:
    - apps/desktop/e2e/{proof,packaged,drag-region}.spec.ts
    - apps/desktop/electron-builder.yml
    - scripts/{check-metrics.ts,check-metrics.test.ts,os-drag.swift}
    - proof/phase-1/{*.png,metrics.json,HUMAN-CHECKS.md}
  modified:
    - scripts/gate.sh
    - apps/desktop/{package.json,playwright.config.ts}
    - apps/desktop/e2e/{chat-bench,browser-arc}.spec.ts
    - apps/desktop/e2e/helpers/proofShot.ts
requirements-completed: [FOUND-06, FOUND-07, PROF-01, PROF-02]
completed: 2026-10-15
---

# Phase 1 Plan 10: Proof, packaging and the final gate Summary

**Eight composite proof screenshots with state assertions, a validated metrics.json, an unsigned arm64 `.app` that launches under a smoke spec, and three consecutive green `EVAOS_PROOF=1 pnpm gate` runs.**

## Task Commits
1. Proof specs, metrics validator, stabilised bench: `40030a7`
2. Packaged build smoke, drag-region check, gate steps: `a8e0c97`
3. Human checks ledger and final proof: see git log (`docs(01-10): human checks ledger and final proof`)

## Chat-bench flake fix
The intermittent `Expected 0, Received 1` was the zero-frames-over-50-ms rule. The rule is unchanged; the measurement now quiesces 2.5 s after the 5,000-row load, runs a 1 s unmeasured warm-up, samples a 5 s idle baseline, and lets the compositor drain 400 ms after the `chat-streaming` capture before sampling resumes. Any long frame is now logged with its duration. Results across three full gates: stream p95 16.6 / 16.6 / 16.7 ms, max 18.8 / 18.3 / 17.4, long frames 0 / 0 / 0, idle p95 16.7, budget 20.88 ms. All three passed.

## Final metrics (last gate)
Display 119.97 Hz, 3840x1080, scale 1. Chat: 5,000 messages, seq gaps 0, contiguous, idle p50/p95/p99/max 8.4/16.9/17.1/17.6 (first full run), stream p95 16.7, long frames 0, pinned gap 0 px. Browser: boundsDeltaPx 0, overlay hides view and bounds restored, CDP text `PAGE B TEXT\nClick me`, DevTools coexist, extension loaded, popup ok, Bitwarden installed 2026.9.3 with content script, Arc import count 3.

## Drag region result
`still-needs-isaac: macOS screen was locked`. The CSS check passes (header computes `drag`, rail children `no-drag`). `os-drag.swift` posts events fine (`CGPreflightPostEventAccess` true) but the console session was locked (`CGSSessionScreenIsLocked`, confirmed with a screencapture of the lock screen), so no event reaches any window. The fallback (title bar change) was not applied because the window did not demonstrably fail to move. Re-run on an unlocked desktop with `EVAOS_OS_EVENTS=1`.

## Deviations from Plan
1. **[Rule 3] Packaged smoke attaches over CDP, not `_electron.launch`.** Playwright injects its main-process loader only for the unpackaged electron binary, so `executablePath` launches always time out (verified with a standalone script; also tried NODE_OPTIONS and `-r`). The spec spawns the `.app` binary with `--remote-debugging-port` and uses `chromium.connectOverCDP`. `isPackaged` is asserted via the shell URL inside `app.asar` (packaged forces live mode, overridden by env vars to fixtures); main-process error array is not reachable, covered by the dev e2e.
2. **[Rule 1] proofShot writes `harness-*` names to test-results**, and browser-arc's extra shot was renamed `harness-import-arc-modal`, so the committed proof tree holds only UI-SPEC shots.
3. **Dev launch log contains the word `Error`** from the real Bitwarden extension's background page (`Could not establish connection`, documented benign in 01-09). electron-vite start line present.
4. Browser tab count in the two-tabs shot is 2 (initial tab plus one new), not 3.
5. `gsd-sdk` metric/decision commands not relied upon.

## Deferred gaps
None beyond still-needs-isaac items in HUMAN-CHECKS.md: real omp session feel, Bitwarden sign-in/autofill on a real site, live Arc import via the UI, drag-region with real OS events, popup anchoring feel.

## Known Stubs
None.

## Self-Check: PASSED
`EVAOS_PROOF=1 corepack pnpm gate` exited 0 three times (154 unit tests, 29 Playwright specs plus packaged smoke, metrics OK).
