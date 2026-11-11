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
- [x] S3 assistant pop-in/out + one-row work card.
- [x] S4 decision cards in rooms (poll, pros/cons, question for Isaac, decision record, catch-up pill, Where we
      are, Since you left). The council proposal card in an assistant's 1:1 chat is S5 (reuses DecisionRecord).
- [x] S5 rooms.create / rooms.update / rooms.list (agent action, relay-linux CLI, Room ready + council proposal
      cards, seat approval asks in rooms).

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
  - Shipped: main 00d54f9f, desktop deploy published build 00d54f9fef (Mini staged "Update ready"; MBP picks it
    up on its next poll). Phone JS is on main but NOT published by OTA: `pnpm ota:publish` in this worktree
    refused the bundle (two copies of react-native in node_modules: not a clean install). Publish it from a
    clean checkout; it is inert until the host advertises rooms.chat.
- 2026-11-11 S3 done (pop-in/out + one-row work card).
  - Data: `relay-guest` omp custom message, `GuestEntry {kind: join|leave|say|work, agent {id,title,color?},
    text?, work? {id,title,state working|done|failed,startedAt,endedAt?,link?}}` in packages/protocol (+
    `foldGuestWork`, ASSISTANT_GUESTS_FEATURE "assistant.guests") and chat-core `guest-entry.ts` (schema,
    `guestEntryOf`, `foldGuestWork`, `guestTyping`, `workLink`; link defaults to `agent:<id>`). State changes are
    new entries with the same work.id; clients show the latest state at the first row's place.
  - Host (apps/linux): `relay-linux assistant consult --agent <B> [--title T] [--work] <question>` (caller =
    $RELAY_ASSISTANT) -> loopback POST /assistant/consult (90 s request timeout) -> `assistant/consult.ts`
    (`Consults`, owned by AssistantThreads): join posted to A (refuses with "restart A's omp" when A's bridge is
    old), B gets `[Asked by <A> in <human>'s chat] <question>`; quick when B settles within 30 s (say + leave,
    the CLI prints the answer), else / --work / B already busy: B's first words as say, leave, work card
    `working`; host keeps watching B, posts `done` (first line of B's reply) or `failed` (B's session ended),
    held until A is idle. Restart recovery: each A session is read once; a `working` card no job watches is
    watched again (B's reply after startedAt finishes it). Bridge request `guest` (omp-extension relay-bridge.ts,
    agents/bridge.ts; aside mid-turn, appended when idle); transcript.ts `guestRowOf`; service.ts maps guest rows
    (join/leave -> status + guest, say/work -> card titled with the guest + guest), folds work in snapshots, and
    shows `[Asked by ...]` turns as status rows; welcome advertises assistant.guests. Starter
    `assistant-prime.md` has an "Other assistants" section.
  - Desktop: MessageRow role `guest` -> GuestRow (centered joined/left line with 16 px face; guest bubble with
    left bar, tint, name in the guest color, `guest` pill) and WorkCard (variant A one row, orbiting conic
    border while working with a reduced-motion pulse, time right: m:ss running / "2m 14s" done, short under
    340 px, gone under 250 px; whole row opens work.link via openFromNav; hover follow-up fills `@Name ` through
    the pane's composer fill). ChatLog folds work then drops quiet turns (guest turns stay, minus the silent
    reply) and shows the guest typing between join and its first words. chat-core parseBackground shows
    `[Asked by X ...]` as a quiet row in B's thread.
  - Phone JS (apps/mobile, committed, NO OTA): store `guests` from welcome (assistant.guests); eva.tsx draws
    GuestLine / GuestBubble / WorkCardRow (tap -> /eva?agent=<id>) via `lib/guests.ts`; without the feature the
    host's status/card fallbacks show as before.
  - Tests: chat-core guest-entry (parse, fold working->done, separate works, failed wins, link, typing), quiet
    (guest turn kept), background ([Asked by]); host consult.test (quick, slow -> card -> done held until A idle,
    busy/--work, failed, old bridge refused, restart recovery) + assistant.test (transcript -> snapshot mapping
    and folding); phone lib/guests.test. e2e `assistant-guests.spec.ts` -> proof/rooms-assistants/s3-*.png.
  - Host: per Eva (2026-11-11) NOT built here: Eva builds one consolidated Relay Host from main. Install steps for
    Isaac: install that Relay Host build; then restart every assistant's omp (the relay-bridge extension gains
    the `guest` request; an omp running the old one makes consult fail with "restart <A>'s omp session"). On
    Isaac's Mac the extension is a symlink into a checkout: update that checkout to main first.
  - Eva-side instruction lines (for Isaac's assistants; they must live where resumed threads load them, i.e.
    Eva's rules or AGENTS.md, not prime.md). Add under the assistants' rules:
    "- When Isaac @mentions another assistant (`@Penny ...`), or you want another assistant's help, bring them
      in: run `relay-linux assistant consult --agent <their id> "<the question, with the context they need>"`.
      Never answer for them. They join this chat, answer as themselves and leave; their answer prints for you
      and Isaac already sees it, so add only what you have to add.
    - Work that takes them longer than about 30 seconds becomes a work card in this chat while they carry on in
      their own chat; it shows their result when they finish. Add `--work` when you already know it is a task
      and `--title "<short card title>"` for a clear card. `relay-linux assistant list` names every assistant.
    - A line `[Asked by <name> in Isaac's chat] ...` is another assistant putting Isaac's question to you:
      answer it as you would Isaac, in your own words; your reply goes back into that chat."
  - Shipped: main bba5571c (WIP) + ae5f2764, desktop deploy published build ae5f276415 (Mini staged "Update
    ready"; MBP not reachable by ssh, picks it up on its next poll). The deploy also moved the Relay runtime
    (omp bridge + relay-linux CLI) to ae5f276415 for new omp sessions; the Relay Host process itself still needs
    Eva's consolidated host build for `/assistant/consult`. Checks: chat-core, protocol, linux (consult +
    assistant), desktop unit 2347 pass; lint ok; desktop typecheck only the pre-existing widget-runtime
    @mantine/core + ThemeControls; mobile typecheck the same 14 pre-existing errors; e2e assistant-guests +
    e2e:smoke green. Pre-existing/flaky: linux canvas-pacing.test (bun:test under vitest), canvas.test and
    chat-core turns.test flake under load (pass alone).
  - Left: phone OTA (from a clean checkout; inert until a host advertises assistant.guests); Eva's rules lines
    above; no in-thread typing for guests on the phone; subagent/inbox views ignore guest rows.

### S4
- 2026-11-11 S4 (worktree work/relay-rooms-decisions, branch eva/rooms-decisions).
  - Contract `rooms-decisions.ts`: card schemas on the RoomCard union (`poll` {question, options, votes by
    author incl. isaac, state open|called|reopened, called}, `proscons` {subject, pros/cons points with by[],
    agreed|disputed, against[]}, `question` {by, text, sub, answers, answered}, `decision` {title, why, agree,
    dissent[{by,note}], next{who,text}, alternatives, poll/option, state proposed|accepted|overridden|reopened,
    previous}); a card's id is the message that carries it. `splitDecisionMarkers` (markers anywhere outside
    code fences, malformed ones cut and ignored, partial ones hidden while streaming), `applyDecisionMarkers`
    (votes, points, disputes, agree/dissent update earlier cards; a decision reads agree/dissent from its poll's
    votes and calls it), Isaac's `voteOn`/`callPoll`/`reopenPoll`/`answerQuestion`/`decide`.
  - Markers members write (taught in the seat system prompt, judge/chair makes the call): `[[poll: q | a | b]]`,
    `[[vote: a or 2]]`, `[[pros: subject | point]]`, `[[cons: ...]]`, `[[dispute: point]]`,
    `[[ask-isaac: q | Yes | No | note: what it changes]]` (ends the burst), `[[decision: call | why | Name: next]]`,
    `[[agree]]`, `[[dissent: why]]`. Each turn's prompt adds "Where the room stands" (cards' current state) and
    transcript lines carry a card note.
  - Engine (chat-room.ts): markers parsed after dedash (no em dash reaches a card), one card per message
    (extra cards follow as same-author messages), a reply that only votes leaves no message. IPC rooms.vote,
    rooms.callPoll, rooms.reopenPoll, rooms.answerAsk, rooms.decide: each a quiet room line the members read
    next turn ("Isaac voted X" rewritten in place on re-votes); answerAsk posts "<question> <answer>" as Isaac and
    the asker speaks first.
  - UI: `rooms/DecisionCards.tsx` (PollView, ProsConsView, QuestionView, DecisionRecord, RoomDecisionCard;
    decisions.css minimal style), `rooms/RoomKeepUp.tsx` (WhereStrip under the notch, CatchUpPill + summary
    panel, SinceBlock), `rooms/decision-view.ts` (pure whereWeAre / catchUp / sinceIndex). "Since you left"
    remembers the last message seen per room in the UI prefs (`rooms.seen`), not room.json.
  - For S5: `DecisionRecord` from `apps/desktop/src/renderer/rooms/DecisionCards.tsx`, props `{ card:
    DecisionCard; people: DecisionPeople (id -> {name, member?}); onDecide?: (action, option?) =>
    Promise<string | null>; onOpen?: () => void }`; `roomPeople(room)` builds `people` from a room.
  - Phone: cards ride on room frames through any host (RoomWire passthrough; RoomWireCard mirrors them) and
    draw in the chat room thread (`src/rooms/DecisionCards.tsx`); their buttons need a host with
    ROOMS_DECIDE_FEATURE ("rooms.decide": RoomsCmd vote/callPoll/reopenPoll/answerAsk/decide). Host code
    advertises it (apps/linux session.ts); host NOT built (Eva builds one consolidated host from main).
  - Tests: contract rooms-decisions.test (each marker, malformed, streaming, tally, decide transitions),
    chat-room.test (cards from seats, no em dash or marker on disk, burst stop on ask, Isaac's actions),
    decision-view.test (strip, catch-up counts, since index), bridge + phone router/model tests. e2e
    rooms-assistants.spec "S4 ..." (FAKE_OMP_ROOM_SCRIPT scripted member replies). Proof:
    proof/rooms-assistants/s4-*.png.
  - Checks: typecheck (all packages, CI style, zero errors in S4 files; contract rooms-chat.test.ts errors are
    S2's, Eva is fixing), lint, desktop/contract/protocol/mobile/linux tests (council.test flaked once under load
    avg ~50, passes alone), build, rooms-assistants.spec 4/4, e2e:smoke 7/7.
  - Shipped: main 89e3a2ab + cf73e2b0, desktop deploy published build cf73e2b0d7 (Mini staged "Update ready";
    MBP on its next poll). Host: code only (rooms.decide advertised in apps/linux session.ts), not built. Phone
    JS on main, no OTA; cards show on any host, buttons need a host with rooms.decide.

### S5
- 2026-11-11 S5 (worktree work/relay-rooms-assistants, rebased on S4 cf73e2b0).
  - Contract `rooms-agent.ts`: agent actions `rooms.create` {title?, members[{assistant|custom, model (exact omp
    id), thinking, role, instructions?}], effort, budget, folder?, refs?, draft?, template?, proposal?} ->
    {roomId, link `relay://open/room/<id>` (the app's existing room link), state idle|proposed, card
    `[[room:<id> | <title>]]`, next}; `rooms.update` {roomId, any field, members as a full list or {add, remove
    [id or name], replace {from, to}}} -> {roomId, link, rev}; `rooms.list`. Helpers resolveMembers,
    changeMembers (a replaced member keeps role, instructions, place; thinking fitted to a new model),
    assistantCeiling, isaacLimits, boundsProblem, roomCardToken. RoomChat gains `by` (who made it, from the
    request scope: `agent:<id>` -> assistant, else the session file), `limits`, `proposal`; Room phase gains
    `proposed`. IPC `rooms.convene`.
  - Bounds (DECISION FOR ISAAC): `ASSISTANT_ROOM_LIMITS = {budget: 10, effort: 4}` in
    packages/contract/src/rooms-agent.ts, enforced in main (rooms-ipc open/update with an origin). An
    assistant-made room keeps `limits`; Isaac's own Save (Edit setup / Members) raises them to what he set; an
    assistant changing Isaac's own room may go up to the default or what Isaac set, whichever is higher.
  - Main: `rooms/rooms-agent.ts` (runners, wired into registerAgentControl as its last arg), ChatRoom
    create(origin)/convene() (once; a second click sends nothing; posting in a proposed room convenes it),
    update(patch, isaac). Seat approval asks in chat rooms: ChatRoom polls the guard's asks dir while seats
    run, each ask is an `ask` card (Isaac's Allow / Deny writes `<askId>.answer` through rooms.answer, which
    now routes chat rooms too); asks left open when the seats stop, at quit or restore are denied. The seat
    prompt now says outward actions wait for Isaac's Allow. Proposals stay off the phone wire (old hosts refuse
    unknown phases) and out of the Rooms nav until convened.
  - Desktop UI: `rooms/RoomCard.tsx` + room-card.css. MessageRow splits `[[room:...]]` (protocol
    `splitRoomCards`, also hidden while streaming) into a live card keyed by roomId: Room ready (title, stack
    with S1 hover cards, roster, effort + cap, folder, Updated ×N from rev, Open room / Edit setup), proposal
    (question, stack, effort + cap, Convene / Edit members / Not now), convened strip (Council · leaning X /
    in session / N for you, from S4 whereWeAre; opens the room), then S4 `DecisionRecord` acting on the room.
    Missing room: "Room deleted"; Not now: "Not now" (declined ids kept in localStorage). Seat asks render as
    S4 `QuestionView` (For you tint, Allow / Deny) via `SeatAskView`; Where we are counts them.
  - Host (apps/linux, code + tests, NOT built): `relay-linux rooms list|create '<json>'|update <roomId>
    '<json>' [--device]` posts the action to the host's existing `POST /control/run` with scope
    `agent:$RELAY_ASSISTANT` (control/rooms-cli.ts); pushes and call speech drop room tokens (a token-only
    reply pushes `Room: <title>`). No new host route: works on the installed host once this CLI is deployed.
  - Phone JS (committed, NO OTA): eva.tsx splits the token; `rooms/RoomCardRow.tsx` opens /rooms/<id> when the
    host has rooms.chat and the room is on the wire, else `Room: <title>`.
  - relay MCP: `.omp/tools/relay-mcp.ts` builds its tools from GET /actions, so rooms_create / rooms_update /
    rooms_list appear with no edit (a running omp picks them up on its next tools/list or session start); its
    scope is RELAY_ASSISTANT, so attribution works. No relay-ctl change either. Eva rule line to add for
    assistants (where resumed threads load rules): "- When Isaac wants several agents to work something out,
    set up a room: relay MCP `rooms_create` (or `relay-linux rooms create`), then put the returned `card` on its
    own line in your reply. For a big decision, propose a council with `proposal: true` and the question as
    `draft`; Isaac convenes it. Change it with `rooms_update`; the card updates itself, never post it twice.
    Your rooms stay within $10 and effort 4."
  - Note: rooms are per desktop; actions go to the Mac Isaac used last (`--device` / relay-mcp `device` picks
    one), and the card renders from that Mac's rooms.
  - Tests: contract rooms-agent.test (params, member resolve/replace/remove/add, bounds, token), protocol
    room-card.test, desktop chat-room.test (proposal convene once, limits + rev, ask card -> answer file),
    linux rooms-cli.test. e2e `rooms-from-chat.spec.ts` (control server actions against the test app) ->
    proof/rooms-assistants/s5-room-ready.png, s5-room-updated.png, s5-open-room.png, s5-proposal.png,
    s5-convened.png, s5-convened-room.png, s5-not-now.png.
  - Checks (CI style, from apps/desktop): `pnpm -r --include-workspace-root typecheck` 0 errors, lint ok,
    `pnpm -r --include-workspace-root test` all green (desktop 2372, contract 123, chat-core 407...), build,
    e2e rooms-from-chat + rooms-assistants 5/5, e2e:smoke 7/7; protocol 215, mobile 917, linux rooms-cli /
    assistant / call / consult green. Outside desktop CI, pre-existing: apps/linux typecheck 3 errors in
    contract agent.ts browser drive refinements (exactOptionalPropertyTypes, pulled in by
    test/avatar-parity.test.ts; browser session's code), apps/mobile typecheck 13 (none in S5 files).
  - Shipped: main 667f3697 + c7ce5f56 (WIP) + db47bff5, desktop deploy published build db47bff56b (Mini staged
    "Update ready"; MBP not reachable by ssh, picks it up on its next poll). The Relay runtime (relay-linux CLI
    with `rooms`) moved to db47bff56b for new omp sessions. Host process not rebuilt (no host route needed).
    Phone JS on main, no OTA.

- S5 polish (RoomsPolish): decision-record face clusters are a clean overlapping stack (22px squares, eva-gap overlap, page-color ring, Isaac's badge same size); 1:1 user bubbles show registry `@Assistant` mentions as the room's `.eva-at-chip` (shared rooms/MentionText.tsx; @computer and unknown words plain). Proof: proof/rooms-assistants/s5-polish-decision.png, s5-polish-chip.png; sha/build id in the final report.

## For Isaac
- Relay Host: install the consolidated host build Eva makes from main (S2 chat rooms on the phone, S3
  consult, S4 rooms.decide), then restart every assistant's omp (S3's relay-bridge `guest` request; on the
  Mini the extension is a symlink into a checkout: update it to main first).
- Eva rule lines: S3's consult lines (S3 log above) and S5's room line (S5 log above).
- Phone: JS for S2-S5 is on main but no OTA is published; publish from a clean checkout
  (`env -u CI pnpm ota:publish`). Each part stays inert until the host advertises its feature.
- Decide the assistant room limits: $10 budget and effort 4 (Deep) by default
  (`ASSISTANT_ROOM_LIMITS`, packages/contract/src/rooms-agent.ts); your own edits lift them per room.
