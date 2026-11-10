# HANDOFF: Rooms effort dial + council (branch eva/rooms-council, worktree work/relay-rooms-council-build)

(The previous file here was the Studio redesign handoff: `git show d2f611bb:HANDOFF.md`.)

Spec (approved 2026-11-10, v2 + addenda + Decisions): Eva `work/relay-rooms-council/SPEC.md`; mock
`work/relay-rooms-council/prototype/index.html` (http://100.85.157.127:4380/). Ledger: Eva
`work/items/relay-rooms.md`. Decisions: Team default, Max capped at 5 rounds, 1 image/round, manual merge,
seats = model x harness, full tools per seat in its own worktree, part split with integrator + shared
contract, routing by model strength with a log, phone-first sizing.

## Rules
Outward actions (push of user projects, deploy, post, email, purchases) need Isaac's yes. Relay's own main
push, desktop deploy (`bun /Users/ike/Eva/.omp/tools/relay-desktop-deploy.ts deploy`) and phone OTA are fine.
Host changes: build and stage, then STOP; the install needs Isaac's heads-up via Nova. Phone stays JS-only (OTA).

## Shape
- Shared model: `packages/protocol/src/rooms-council.ts` (notches, casting, routing flip, cost and time
  estimate; one source for desktop, host and phone).
- Wire: `packages/protocol/src/rooms.ts` (ROOMS_FEATURE; rooms.sync/upsert/get/state/room/cmd/res).
- Desktop contract: `packages/contract/src/rooms.ts` (RoomSeat, RoomCouncil, RoomCard, RoutingEntry;
  rooms.create council input, rooms.raise, rooms.budget, rooms.answer).
- Desktop main: `apps/desktop/src/main/rooms/` (service.ts interface; seat adapters per harness; council
  orchestrator; workdir `<eva>/work/rooms/<room>/main` + `seats/<seat>` git worktrees; outward-action guard).
- Desktop renderer: `apps/desktop/src/renderer/rooms/` (dial, parts row, phase strip, spend meter, cards).
- Host: `apps/linux/src/rooms/` relay. Desktop bridge: `apps/desktop/src/main/relay/rooms-bridge.ts`.
- Phone: `apps/mobile` Rooms screens (gated on ROOMS_FEATURE).

## Milestones
- [x] M0 2026-11-10: contract committed (63fd435b). Codex CLI 0.167.0 installed (`npm i -g @openai/codex`);
  `codex exec --json` and `claude -p --input-format stream-json` both smoke-tested on the Mini.
- [x] M1 2026-11-10: engine + seat adapters (omp, Claude Code, Codex; outward-action guard), desktop
  dial/phase strip/spend meter/cards, host relay + desktop bridge, phone Rooms screens. Run died ~18:44Z
  (disk full); resumed 19:18Z, the three unfinished slices finished in place.
- [x] M2 2026-11-10: on main (cd9c5032, fixes 758e5c04 and 6c8afae6). Desktop deployed: build
  6c8afae65b published (Mini staged "Update ready"). Host: the installed Relay Host 0.2.89 (built from
  main by another session) already carries the rooms relay (`rooms.sync` in its binary); nothing left
  to install. Phone OTA 761bc083-6e1b-898b-94da-3e9eb6331fa3 (runtime 0.1.0; rooms gated on the
  host's `rooms` feature). Desktop proof: `proof/rooms-council/desktop-*.png` (fixture data).
  Phone proof: none in the Simulator (Isaac's order: he tests on the device).
- [x] M3 2026-11-10: Lockdown Maul at Team, real run in a hidden Relay Dev: 19.2 min, $5.41 list (cap
  $5.31; paused at 99% after round 1's merge, answered "wrap"). Contract + 2 parts built in parallel,
  1 paintover, merged (151/151 contract checks). Judge's final position: Head 4, Body 5, Hands 4, Legs
  4, Look 7, integration 6, GG preservation 8. Record `memory/rooms/2026-11-10-make-the-lockdown-maul-
  render-match-the-target-art-keep-the-2.md`, routing log beside it, work in
  `~/Eva/work/rooms/room-mwb4t3f4-1/main`. The first attempt hung on the Codex art director's turn
  (generated image copied in-process under the Eva root, where the app's write trap throws); fixed in
  758e5c04; that attempt spent about $3.40 list before it was stopped.

## Checks
Desktop: typecheck clean (only the old widget-runtime @mantine/core error), 2356 unit tests, lint,
spacing and em-dash lint. Host: 881 tests. Phone: 901 tests. Real seat smokes per harness (omp, Claude
Code, Codex): file written, usage back, Codex resume, a real `git push` turned into an ask and denied.

## Next
- The integrator (Opus) took $3.70 of $5.41: its contract turn alone was $2.15 against the dial's
  ~$3.5 room estimate. Either raise the integrator's estimate or cap its contract turn; Team cannot
  finish a scored round inside its cap today.
- `EVAOS_HIDDEN_WINDOW=1` still put a Relay Dev window on screen; hidden via System Events.
