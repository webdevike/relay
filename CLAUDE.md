# Unattended run rules

Isaac is asleep. Sessions run headless, one per phase. Never wait for input.

## Verification
- Never answer a verification question by just skipping it. Verify it yourself first.
- `human_needed` items: test each one with Playwright for Electron (launch the app, drive the UI, take screenshots into `proof/phase-<N>/`). Record each item in that phase's VERIFICATION.md as `agent-verified` (with the screenshot path) or `still-needs-isaac` (with the reason a human is required, e.g. real omp session, real sign-in, feel/smoothness). Then continue to the next phase.
- `gaps_found` after the automatic gap-closure retry: choose to defer, list the gaps under `## Deferred gaps` in VERIFICATION.md, and continue. Do not stop the run.
- A phase is not done unless the app still builds and launches. Run the tests before marking it complete.
- Milestone audit: if it reports gaps or tech debt, accept/defer and record them; do not stop.

## Boundaries
- Read-only: `/Users/ike/Eva/apps/evaos`, `/Users/ike/Eva/work/relay`, anything outside this repo except the exact Eva data writes current EvaOS performs.
- No global config changes, no remote, no push.
