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
- [ ] M1 engine + adapters, renderer, host relay + bridge, phone (parallel slices). HostBridge and
  DialRenderer done (host 0.2.82 built in apps/mac-host/build, pre-integration). Run died ~18:44Z
  (disk full); resumed 19:18Z: SeatAdapters, CouncilEngine, PhoneRooms relaunched to finish in place
  (briefs in `.council-briefs/`, not committed).
- [ ] M2 integrated, checks green, desktop deployed, host built (not installed), phone OTA
- [ ] M3 Maul demo at Team, measured cost and time

## Checks
(filled per milestone)

## Next
(filled per milestone)
