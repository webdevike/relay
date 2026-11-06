# HANDOFF: @computer v1 (branch eva/computer, worktree work/relay-computer)

Spec: `SPEC.md`. Order: headless, then live, then walk; each verified before the next.

## Status
- [x] SPEC.md
- [ ] headless: parser + routing + driver + agent loop + chat rows + approvals; e2e (hidden window)
- [ ] live: Assist `--present`, presenter client, overlay glide + click per action
- [ ] walk: step planner, pointing, voice, done checks
- [ ] deploy desktop (main fast-forward + relay-desktop-deploy.ts deploy)

## Notes
- Never relaunch or drive Relay Desktop's own UI to test; composer parsing is covered by the e2e
  harness (hidden window).
- Host (apps/linux) untouched so far: no host install needed.
