# HANDOFF: Rooms inside Assistants (worktree work/relay-rooms-assistants, branch eva/rooms-assistants off origin/main)

(The previous file here was the Rooms council handoff: `git show 16569631:HANDOFF.md`.)

Source of truth: the clickable prototype Eva `work/rooms-assistants-proto/` (index.html, decisions.js/css,
README with the rooms.create/rooms.update shape, screenshots in refs/), served at http://100.85.157.127:4817/
(also /cards and /decisions). Code map: Eva `work/rooms-assistants-build/code-map.md`. Ledger: Eva
`work/items/relay-rooms.md`. Design rules: Eva `references/glossary.md` ("glance, get it, go"), skill isaac-design.

## Isaac's decisions (approved 2026-11-11)
1. Rooms live in the Assistants page left nav as a "Rooms" section, built on the persistent + resumable rooms
   engine (room.json per room, resume the same seats, hard budget cap, seat tmp/ folders).
2. New room page only assembles the room: optional title (auto from first message), members = real
   assistants or custom agents (name, EXACT model from a grouped searchable picker of real omp models, separate
   thinking level), templates Debate / Council / Build team as editable presets, effort + budget, optional
   folder / refs. "Create room" lands in an empty room; nothing runs until Isaac's first message.
3. Room chat = the same chat UI and composer, multi-speaker: notch header with an overlapping tilted
   rounded-square avatar stack, no names; hover card (name, role, exact model + thinking, status, instructions
   summary, cost); speaking ring. No template label, no Round/Decision bar, no Pause button. Context menu
   (right-click in nav, "..." in header): Rename, Pause/Resume, Duplicate, Members, Delete.
4. One @ picker in every composer: agents + actions. @computer keeps today's behavior; @Agent inserts an inline
   chip and pulls that agent in.
5. Assistant chats: no invite button. Other assistants pop in (host pulls them in, or Isaac @mentions) with
   quiet "X joined/left the chat" lines and guest bubbles (avatar + name + guest tint). Quick answers then
   leave; real work becomes the one-row work card (variant A) while the work continues in that assistant's
   own thread.
6. Decision UI, minimal style: poll, pros/cons, decision record, council proposal card (Convene / Edit members
   / Not now; live strip; resolves to a decision record), catch-up pill, "Where we are" strip, "Since you left".
7. Assistant-callable rooms.create / rooms.update (desktop agent action, so relay MCP + relay-ctl, and the
   relay-linux CLI through the host) so any assistant sets up a room from conversation and posts a "Room ready"
   card.
8. The "Full access" picker is already gone (f84a2ded).

## Rules
- Never focus, drive or relaunch Isaac's live Relay app. App launches are hidden e2e (`EVAOS_E2E=1`).
- Relay main push, desktop deploy (`bun /Users/ike/Eva/.omp/tools/relay-desktop-deploy.ts`) and phone JS OTA
  (`env -u CI pnpm ota:publish`, clean install only) are fine. Host (Relay Host / relay-linux) installs:
  build and stage, then STOP; Isaac gets a heads-up via Nova. Native phone changes: stop and ask (TestFlight).
- No em dashes in UI strings or copy. No iOS Simulator.
- Each slice: lint, unit tests, `electron-vite build` + hidden e2e for the changed specs, push main, deploy OK.
- Parallel session (Nova, 2026-11-11 21:02Z) builds the shared agent browser in Relay desktop: never edit
  browser/web-tab files; `git fetch && git rebase origin/main` before every push. The S3 work card must be
  able to link to an agent's browser tab later (keep its target a generic link, not chat-only).

## Architecture decisions (Eva, 2026-11-11)
- New rooms are kind `chat`: a persisted conversational room. Setup = {title?, template, members[], effort,
  budget, folder?, refs[], draft?}. Member = {id, assistant? (registry id), name, model (exact omp
  `provider/id`), thinking (omp level), role, instructions?}. State in `<eva>/work/rooms/<roomId>/room.json`
  (same dir and atomic-write pattern as council `state.ts`). Created `idle`; Isaac's first post starts it.
- Engine (slice 2): each member is an omp seat (reuse `council/seat-omp.ts` style: own session file resumed
  after restart, seat tmp dir, room workdir with the folder copied in, outward-action guard). Isaac's post
  opens a round; speaking order = mentioned members first, then setup order; effort bounds turns per post;
  spend from usage against the hard cap (pause before a turn that would cross it).
- Council rooms (effort dial, shipped for the phone) stay and list in the same Rooms section; the debate
  RoomSession (in-memory) is superseded by the chat engine and removed with its callers (clean cutover).
- The old top-level Rooms page/nav row is folded into Assistants > Rooms.

## Slices
- [x] S1 nav + new room + empty room (contract, persistence of idle rooms, Rooms section in the Assistants
      sub-nav, New room page with templates + member editor + model picker, empty room view, context menu).
- [x] S2 multi-speaker room chat + unified @ picker (engine, notch avatar stack, hover card, speaking ring).
- [ ] S3 assistant pop-in/out + one-row work card.
- [ ] S4 decision cards (poll, pros/cons, decision record, council proposal, catch-up pill, Where we are,
      Since you left).
- [ ] S5 rooms.create / rooms.update tool (agent action, relay-linux CLI, Room ready card).

## Log
- 2026-11-11 worktree created off origin/main 16569631; code map written.
- 2026-11-11 S1 done (the list below plus NewRoomPage/RoomSetupForm, RoomPage, MainHeader room branch, AssistantsList
  Rooms section, tests, css, e2e). Checks: typecheck clean except `packages/widget-runtime/src/theme.ts` not
  resolving `@mantine/core` in this worktree (file untouched; install issue); lint ok (spacing baseline shrunk);
  unit tests 2325 pass (habit-ipc.test flaked once under load, passes alone); `e2e/rooms-assistants.spec.ts`,
  sidebar.spec and `e2e:smoke` green. Proof: proof/rooms-assistants/s1-*.png.
  Phone: chat rooms are kept OFF the phone wire (rooms-bridge.ts). Reason: every installed Relay Host validates rooms
  with RoomWireSchema, which knows only open|wrapping|resolved|failed|paused and drops the desktop's socket on a
  frame it refuses, so an `idle` chat room would cut the Mac off; the phone's room screens are council-shaped too.
  They go out once a host + phone update knows `idle` and chat rooms (S2 or later). No phone code changed, no OTA.
  rooms-resume.live.spec now opens rooms by place; not run (real models, opt-in). Earlier progress notes:
  - contract: `rooms-chat.ts` (ChatRoomSetup/Member/Patch schemas, OMP_THINKING_LEVELS, templates + ROLE_INSTRUCTIONS,
    templateMembers, fitThinking, memberProblem, autoTitle, memberIdFor, ROOM_EFFORTS); `rooms.ts`: phase `idle`,
    Room `kind` (default council) + `chat {setup, rev}`, roomActivity, roomRunAction, IPC rooms.open/update/rename/
    duplicate/delete, event rooms.removed, rooms.create is council-only. Assistant gets optional `model`. page.open
    takes `room:<id>`; agent-access lists `rooms` (New room) and `room:<id>`. shell-core PageKey `room:${string}`.
  - main: `rooms/chat-room.ts` (ChatRoom: create/restore/update/rename/post (S2 hook)/react, atomic room.json);
    `council/state.ts` reads/writes chat + council states, owns newRoomId; `rooms-ipc.ts` rewritten (chat rooms,
    catalog check, delete removes work/rooms/<id>, list by activity); `service.ts` (open/update/rename/duplicate/
    delete/onRemove, 'not-chat'); council `rename`; rooms-bridge keeps chat rooms off the phone wire (host refuses
    `idle`) and resyncs on delete; assistants read registry `model`.
  - Debate engine removed (clean cutover): orchestrator.ts(+test), runner.process.test, contract rooms-roster.ts;
    runner.ts -> omp-frames.ts (frame helpers only), jev.ts -> computer/jev.ts (key + endpoint only), prompts.ts
    trimmed; tests trimmed to kept helpers; save.test inlines its people.
  - renderer: rooms-store rewritten (open/update/rename/duplicate/delete, renaming/editing UI state, activity order,
    room titles to names-store), page-meta/tab-meta/registry/PageRouter/nav-level(inAssistants)/MainNav/open-link
    know `room:<id>` and `rooms` = New room; new `model-catalog.ts`, `RoomModelPicker.tsx`, `MemberStack.tsx`,
    `RoomComposer.tsx`, `RoomMenu.tsx` (menu, delete confirm, inline rename, header title/menu).
- 2026-11-11 S2 done.
  - Engine: `rooms/chat-turns.ts` (burstFor/nextSpeaker/afterTurn: mentioned members first, then setup order,
    @handoff puts that member next, effort x members turns capped at 20, a Judge/Chair role gets the last word,
    @Isaac with no handoff ends the burst). `rooms/chat-room.ts` runs it: each member an omp seat
    (`SeatSpec.model` is now a council key or `{omp}` exact id, `thinking` any omp level; council untouched),
    own session file under `sessions/<member>` (saved in room.json `seats`, resumed), scratch `tmp/<member>`,
    cwd `main/` (RoomWorkdir.create, `source` now optional, setup.folder copied in, refs under refs/), guard
    via the launcher, system prompt with role, instructions, registry persona, other members, question and
    chat rules. Turns stream (partials + presence) through rooms.changed; spend from usage at omp catalog
    prices (`ModelInfo.price` from omp `cost`, else the council table; `usageCost` generalised in protocol),
    `room.chat.spend {usd, byMember}`. Hard cap: a turn whose estimate (last cost x1.25, else 8k in / 800 out)
    would cross the budget is not started; the room pauses with a quiet line; Resume refuses until Members
    raises the budget. Pause aborts the turn in flight (it reruns on Resume) and stops seats; quit or crash
    mid-burst comes back paused (never auto-runs). Isaac posting mid-burst redirects the next turn. @Assistant
    not in the room joins as a guest (setup rev bump, "X joined as a guest", speaks first). Phases for chat:
    idle (nobody speaking) / open (a burst) / paused. Seats stop 5 min after a burst.
  - UI: RoomFeed draws chat rooms multi-speaker (member face, name, role tag; Isaac as the chat's user bubble
    with chips; quiet centered system lines; presence row with faces at the log end); notch stack speaking
    ring (data-turn, member color, reduced-motion off); hover card live status + real cost; header spend
    `$x / $cap` + bar before "..."; context menu Pause/Resume for chat rooms (roomRunAction).
  - One @ menu (`chat/composer/at-menu.ts`): Agents (chat: its assistant "in this chat", then the registry;
    room: members "in this room", then "<scope> · joins as guest") then Actions (Computer + skills, unchanged).
    Picking an agent inserts `@First ` drawn as an inline chip (`MentionBackdrop`). rooms/mentions.ts keeps
    only mentionMarkdown; canvas `mentionablesOf` became `agentsOf` in at-menu (Canvas + doc comments use it).
    A room's menu has no Actions (no computer runs in rooms). In a 1:1 chat @Agent only inserts the chip and
    sends the text as is (pull-in is S3).
  - Phone wire: protocol ROOMS_CHAT_FEATURE ("rooms.chat"), RoomWire `kind`/`chat`, phase `idle`, `rooms.get
    {chat}`. Host (apps/linux) relays chat rooms only to phones that ask with chat:true and advertises the
    feature; desktop bridge sends chat rooms only to such a host; phone asks with chat:true only when the host
    advertises it, and draws chat rooms (status/spend, role tags, quiet lines, Pause/Resume, posts any time).
  - Tests: chat-turns.test (order, handoff, effort, judge last, Isaac stop), chat-room.test (burst over seats,
    budget cap never crossed + resume after raise, pause/resume persistence with seat session resume after a
    restart, crash mid-burst, guest join), at-menu.test (Agents + Actions rows, room rows), bridge + host relay +
    phone model/router tests. e2e rooms-assistants.spec S2 x2 (fake omp seats: `--system-prompt` "You are
    <Name>, a member of a Relay room" answers as that member). Proof: proof/rooms-assistants/s2-*.png.
  - Host: built (not installed) `apps/mac-host/build/Relay Host.app` + `RelayHost.zip`, version 0.2.92
    (`cd apps/mac-host && ./build.sh 0.2.92`). Isaac installs it (or `./build.sh 0.2.92 --release` to ship
    it on the update channel); phone chat rooms light up only after that host runs.
  - Left: guard asks from chat-room seats are not surfaced (they wait 10 min, then deny); no memory/rooms
    record on finish; @computer in a room is not offered.
