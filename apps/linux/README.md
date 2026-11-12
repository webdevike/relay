# Relay for Linux

The Linux host: the same wire protocol as `apps/mac`, so the phone app pairs and connects
without changes. Runs as a terminal daemon on Bun.

```
src/main.ts          CLI: serve (default), devices, forget <deviceId>
src/server.ts        Bun.serve WebSocket listener, one ClientSession per connection
src/session.ts       Port of ClientSession.swift (hello -> challenge/auth | pairing -> welcome)
src/dedup.ts         Port of CommandDedupStore.swift (cmd replay across reconnects)
src/pairing.ts       Port of PairingCoordinator.swift + terminal PIN display
src/device-store.ts  Paired secrets in $XDG_CONFIG_HOME/relay/devices.json (0600)
src/mdns.ts          `_relay._tcp` via avahi-publish (TXT v=1, name=<host>)
src/input/uinput.ts  Virtual mouse+keyboard on /dev/uinput (bun:ffi for ioctl only)
src/input/trackpad.ts, pointer-model.ts   Port of TrackpadInputSink / PointerModel
src/input/keyboard.ts  Named keys via uinput; text via wtype (Wayland) or a US-layout fallback
src/vnc.ts           Live view: /vnc tickets and the WebSocket <-> 127.0.0.1:5900 VNC bridge
```

## Requirements

- bun >= 1.2, `avahi-daemon` running with `avahi-publish` installed.
- Read/write on `/dev/uinput`: add yourself to the `input` group (`sudo usermod -aG input $USER`,
  then log out and in), or a udev rule such as `KERNEL=="uinput", MODE="0660", GROUP="input"`.
- Wayland: `wtype` for Unicode text. Without it (or on X11) text falls back to uinput with a US
  layout and non-ASCII characters are refused with `invalid_command`.

### macOS

The bundled `Relay Host.app` uses `relay-input.dylib` (CoreGraphics) for phone
trackpad movement, clicks, dragging, pixel scrolling and Unicode keyboard input.
It does not attempt to open `/dev/uinput` on macOS. Build with
`sh apps/mac-host/build.sh <version>`; the native input library ships beside the
compiled daemon. For source runs, set `RELAY_INPUT_LIBRARY` to that built library.

Grant **Relay Host** access in System Settings → Privacy & Security →
Device Control and Data Access (Accessibility). Until granted, input is refused
while pairing and chat continue to work. Trust is checked live, but macOS can cache
the result in the daemon. Restart Relay Host after granting access, then reconnect
the phone to refresh its status.
The native backend uses all active display bounds, including extended AirPlay displays.
Existing Linux Ctrl shortcuts map to macOS Command, and text uses UTF-16 events.

Bonjour goes through the system mDNSResponder (`dns-sd -R`), the agent socket is
`/tmp/relay-agents.sock`, and the clipboard watcher remains off without `wl-paste`.

### Live view (VNC)

The phone's live view is a VNC client (noVNC) for the whole Mac desktop, served by macOS's own
Screen Sharing. Turn it on in System Settings → General → Sharing → Screen Sharing; it listens on
port 5900 (`serve --vnc-port N` for another local port). The host never exposes that port: an
authenticated phone sends `vnc.open` over its relay socket, the host checks that
`127.0.0.1:5900` accepts connections and answers with a single-use ticket valid for 30 seconds
(`vnc.ticket`), or `vnc.unavailable` when Screen Sharing is off. The phone then opens
`ws://<host>:<port>/vnc?ticket=<ticket>` (subprotocol `binary`), and the host pipes raw bytes
between that WebSocket and the VNC port (websockify semantics). Requests without a live ticket
get 401. Screen Sharing then asks for its own credential: a macOS account name and password, or
the VNC password set under Screen Sharing → Computer Settings; the phone keeps it in Keychain.

### NixOS

The flake at the repo root packages the daemon (`bun` plus avahi, wtype and wl-clipboard on its
PATH) and a module that sets up everything above:

```nix
# flake.nix inputs
relay.url = "github:webdevike/relay";

# configuration.nix (with relay in the module's args)
imports = [ relay.nixosModules.default ];
services.relay-linux = {
  enable = true;
  users = [ "you" ];   # joins the uinput group; log out and in once after the switch
};
```

That enables `hardware.uinput`, avahi with user-service publishing, opens TCP 7817, and installs a
systemd user unit `relay-linux` bound to `graphical-session.target`; the PIN shows in
`journalctl --user -u relay-linux -f`. Without the module: `nix run github:webdevike/relay -- serve
--port 7817` (uinput, avahi and the firewall are then yours to configure). For the Agent Inbox,
symlink `/run/current-system/sw/share/relay-linux/omp-extension/relay-bridge.ts` into
`~/.omp/agent/extensions/`.

## Run

```
cd apps/linux
bun run src/main.ts serve            # ephemeral port; --port N --name NAME to override
bun run src/main.ts devices
bun run src/main.ts forget <deviceId>
```

The phone finds the host through Bonjour, sends `pair.request`, the PIN prints in this terminal,
and after `pair.ok` every reconnect authenticates with HMAC over the stored secret. Pointer motion
is emitted as relative `REL_X/REL_Y`; the compositor's own libinput acceleration applies on top of
`PointerModel`'s. Scroll is `REL_WHEEL_HI_RES` (120 units per 24 phone pixels) plus a legacy
`REL_WHEEL` click per whole notch.

When `/dev/uinput` cannot be opened the daemon still runs: the phone sees
`accessibilityGranted: false`, input is dropped and commands are nacked `accessibility_denied`.

## Agent Inbox (omp)

Symlink `omp-extension/relay-bridge.ts` into `~/.omp/agent/extensions/`. Every interactive omp
session then registers with the daemon over `$XDG_RUNTIME_DIR/relay-agents.sock` and appears in
the phone's Agent Inbox with its transcript and status (`working`, `waiting` after a turn that ends
in a question, `needs_permission` during a tool approval prompt, `idle`, `ended`). An
`agent.reply` with `submit: true` is delivered like typing in the TUI and pressing Enter (a text
that starts with `/` is fed through the editor so omp dispatches it as a command); with
`submit: false` it is placed in the session's editor for the keyboard to finish. Images pasted on
the phone ride along on the reply as image parts of that user turn (so they always submit, and a
`/command` sent with images goes to the model as text rather than being dispatched); images in the
transcript, whether pasted or returned by a tool, are listed on the message as references and
fetched by id with `agent.image` (the extension keeps the newest 32). `agent.options`
answers with the models the session can switch to and the entries for the phone's skill wheel and
its typed `/` menu: authored skills (`/skill:<name>`), prompt and extension commands, and the
built-in commands that take text (`/handoff`, `/rename`, ...); a built-in with subcommands offers the
ones that take text (`/goal set`, `/compact <mode>`), each entry carrying the exact token to prefix
and, for built-ins, omp's argument `hint` (`[focus instructions]`, `<objective>`). `agent.start`
(the plus on the phone's scrubber, Relay desktop's chats on a remote host) creates a Herdr workspace
and starts omp there. The phone sends no profile, so omp runs on its default account; a client's
optional `personal` or `work` profile (Relay desktop's) goes after Herdr's argument separator, so omp
reads that profile's isolated authentication and state. `<dir>` is `serve --agent-home DIR` (default `$HOME`).
`agent.end` (End session in the phone's session sheet) submits `/exit` in the TUI once the ack has
gone out, so omp tears down exactly as it would from the keyboard and its terminal closes.

Each status also carries what the session is busy with besides its turn. `backgroundJobs` lists its
async jobs (`bg_N` bash commands, eval cells; read from tool results whose `details.async.state` is
`running`, ended by omp's async-result delivery, a `wait` snapshot, or a proc:// kill), each with
its command as the label; an ended job stays listed for a minute with how it finished.
`handingOff` is set from a `/handoff` submit (or omp compacting on its own) until the compaction
lands, at most five minutes; every compaction adds a "Context refreshed: earlier turns summarized"
row to the transcript. A `/handoff` from the phone while a turn is streaming is not submitted (omp
would refuse it in the terminal only); the transcript gets a system row saying so instead. `goal`
is omp's goal mode while the goal is active or paused (`objective`, `paused`, `tokensUsed`), read
from the session's last `mode_change` at start and kept by omp's `goal_updated` event; a goal that
was met or dropped is gone. Extensions load once per omp process, so a session started before an
extension change keeps reporting what the old code did until it is restarted.

A thread's subagents are sessions of their own (`<thread session id>:<name>`, `parentId` set), so the phone
can open their transcripts. The extension mirrors each one from the task tool's lifecycle events; when no
mirror reaches the host (its socket went to another process, see below), `src/agents/subagent-mirrors.ts`
registers the same session from the helper's transcript file: for every helper in `ArtifactService.helpers()`
whose thread's session is live and that no listed session already covers, it opens one more socket to the bridge
and speaks the extension's protocol (`hello` with `parentId`, `canRespond: false`, `status` from the helper's
state, the transcript as `conversation` and live `messages` appends, `end` clears it). A real mirror that arrives
later replaces it. It is read-only: a reply or stop answers that the helper is read from its transcript.

An assistant's own sessions (auto-work, delegated work: the omp has `RELAY_OWNER` set, which the extension reports as
`owner`) belong to its thread: they list under it, their helpers are its activity chips, and `assistant:<id>`'s
Artifacts read their transcripts (`threadFiles` adds every live session it owns, so a helper shows in either profile).
A profiled omp (`OMP_PROFILE`, `--profile`) does not discover `~/.omp/agent/extensions`, so a session started under one
without `--extension relay-bridge.ts` never reaches the host. `src/agents/owned-sessions.ts` reads those from the
assistant's record (`<agent home>/work/eva/agents/<id>/sessions.json`: open entries whose transcript, in any profile's
`sessions` folder, was written in the last 6 hours) and the same mirrors register each as a top-level read-only session
(`hello` with `owner` and `sessionFile`, no `parentId`; `working` while the file is written, else `idle`), after which its
helpers follow like any other thread's. A real extension that connects later replaces it.

The bridge socket (`$RELAY_AGENTS_SOCKET`, default `$XDG_RUNTIME_DIR` or `/tmp` `/relay-agents.sock`) belongs to one
host: it writes `<socket>.pid`, and a second host that finds that pid alive refuses to start. A test or proof
host must set its own `RELAY_AGENTS_SOCKET`; binding the default path unlinks the live host's socket, and every
omp or subagent mirror that connects afterwards reaches the wrong process until the real host restarts.

A `/goal` sent from the phone goes in the form the terminal runs without asking anything back
(`src/agents/goal.ts`, as EvaOS maps it): `/goal <objective>` sets it, bare `/goal`, `status` and an
objectiveless `set` read it (`/goal show`), `clear` drops it, and the "Drop goal?" confirm a drop
opens in the terminal is answered Yes. A skill the user invoked (`/skill:<name> args`, omp's
`skill-prompt` custom message) shows in the transcript as that command, live and when a session
file is read.

### Tool approvals

A session in an approval mode (`--approval-mode always-ask`, or `write` for a write or exec tool) blocks
on omp's prompt `ctx.ui.select("Allow tool: <name>\n<details>", ["Approve", "Deny"])`. The extension wraps
that select: the prompt still opens in the terminal, and the host also gets `approval.request` (tool call
id, tool name, the detail lines verbatim, omp's reason) and sends subscribed devices `agent.approval`.
`agent.approve` / `agent.deny` (`sessionId`, `approvalId` = the tool call id) answer it; whichever answers
first wins, a device's answer closes the terminal selector through its abort signal and omp carries on as if
it had been picked there, and every device gets `agent.approval.resolved`. A late answer nacks
`agent_cannot_respond`. The host replays a pending approval to a device that subscribes after it was raised,
and the extension raises it again if the host restarted meanwhile.

A call that matches the destructive list (`src/agents/destructive.ts`: force push, `rm -rf`, deploy, writes
under `prod`/`production` paths; the same list as EvaOS's inbox) is sent with `requiresBiometric: true` and
a `destructive` name. Approving one needs `confirmed: "biometric"` (Face ID on the phone) or
`confirmed: "desktop"` (EvaOS, at the Mac); without it the ack is `biometric_required`. Denying never needs
it. There is no "always allow" for these, and the protocol has none for any approval.

### Phone escalation (`inbox.item`, `inbox.resolve`)

EvaOS decides what reaches the phone (apps/evaos `src/inbox/escalate.rs`: away from the Mac, 45 s unanswered,
not quiet hours or a habit break, rate limited) and speaks to the host as the device `evaos`
(`ESCALATOR_DEVICE_ID`). `src/inbox/service.ts` is the host half:

- `inbox.item` from `evaos` (an `approval`, an `ask` with up to four options, or an `alert`) is kept, relayed
  to every other device and replayed to a device that connects later. A new id also pushes a Time Sensitive
  notification through Expo with the item's `categoryId` (`INBOX_CATEGORY`: `relay.approval`,
  `relay.approval.biometric`, `relay.ask`) and everything the phone needs to answer with the app killed
  (`data`). The same id again, `silent` items and sessions a phone has open do not push. A `passive` item (a
  digest) pushes with no sound and is not kept.
- `inbox.resolve` from `evaos` (answered on the Mac or in the chat) is relayed to the phones and withdraws
  the delivered notification with a silent push (`{ withdraw: <id> }`, content-available).
- A phone's own answer (`agent.approve`, `agent.deny`, `agent.ask.answer`) is claimed by the session before it
  runs (`InboxRelaying.claim`); omp's resolved event then makes the host send `inbox.resolve { by: "phone",
  answer }` to every device, EvaOS included, ahead of the plain `agent.approval.resolved`, so the Mac's row
  reads "answered on iPhone". A refused answer (no Face ID) releases the claim.
- While `evaos` is connected the host's own "session is waiting" pushes (`AttentionNotifier`) are suppressed:
  the engine already applied the rules. Without EvaOS they behave as before.
- `RELAY_EXPO_PUSH_URL` points the push sender somewhere else (a scratch host captures sends locally).
- How pushes read on the lock screen: an assistant reply is titled with the assistant's name, its body is
  the reply's opening sentences as plain text (`src/push/preview.ts`: markdown, code, images and the
  `[[replies: ...]]` token dropped, at most `MAX_PUSH_BODY` characters), stacked per assistant
  (`threadId: assistant:<id>`) and sent `mutableContent`, so the phone's Notification Service Extension
  shows it as a Communication Notification with the assistant's portrait. Inbox items lead with
  `Approval · ` or `Question · ` and stack by kind (`inbox:<kind>`); the host's own session pushes lead
  with `Job · ` or `Session · ` (an assistant's session with its name alone) and stack per session.

## Catch Up (`catchup.list`, `catchup.mark`, `catchup.handoff`, `catchup.bounce`, `catchup.note`)

The phone's Catch Up deck comes from a feed file written in the Eva hub by `.omp/tools/catchup-build.ts`
(`<agent home>/work/elysia/catchup.json`, `CatchUpFeed` in the protocol; `RELAY_CATCHUP_FEED` overrides
the path). The host watches the feed's directory, keeps read state per item id in
`$XDG_CONFIG_HOME/relay/catchup-state.json` (0600; marks for ids gone from the feed are dropped after
30 days), and sends every phone one `catchup.snapshot { items, unreadCount }` whenever the feed or the
read state changes. `catchup.list` answers the asking phone; `catchup.mark { id, read }` changes the state
(an unknown id or no change re-sends the snapshot to that phone only). "Keep Unread" is phone-only: the
card stays unread and goes to the back of that app session's deck. Without an agent home the deck is empty.

Handoff: `catchup.handoff { id, agent, note? }` (swipe up, the send button, or the long-press sheet) sends the
card to that assistant's thread as Isaac's turn (`AssistantThread.turn`), with its label, title, body, link,
the note, and the rules (`handoffMessage` in `src/catchup/service.ts`: normal permissions, anything posting as
Isaac needs his approval, bounce instead of guessing when out of scope or blocked, do the part it can and ask
one question otherwise). The card is marked read with `handedTo` at once; a failed delivery puts it back.
The feed's `assistant` field (Astra for eCard sources, Nova for the rest) is the phone's default target.

Bounce: an assistant runs `bun ~/Eva/.omp/tools/catchup.ts bounce <id> "<reason>"` (agent from
`$RELAY_ASSISTANT`), which posts to `POST /catchup/bounce` on loopback (`{ id, agent, reason }`; the
`catchup.bounce` frame does the same). The card is unread again, no longer handed, first in the deck with
`bounce { agent, reason, at }`, until Isaac reads it. All of it persists in `catchup-state.json`
(`read`, `handed`, `bounced`).

Note: `catchup.note { id, signal?, text }` (the card's note button) is Isaac saying why a card does or does
not need him: `signal` is a chip (`needs-me`, `not-actionable`, `fyi`), `text` is free text, at least one is
set. The host appends one JSON line `{ at, cardId, source, label, title, kind?, workspace?, assistant?,
signal?, text }` to `<agent home>/work/eva/agents/nova/catchup-notes.jsonl` (`RELAY_CATCHUP_NOTES`
overrides the path) and answers the phone `catchup.noted { id, ok }` (`ok` false for an id gone from the
feed, an empty note or no agent home). The card's state does not change. The Eva heartbeat brings each new
line to Nova, who keeps `catchup-rules.json` (applied by `catchup-build.ts`) and `catchup-taste.md` (read
by Elysia) next to it. The deck keeps the feed's order after bounced cards, so the builder's ordering
(pinned first, downranked last) is what the phone shows.

## Reactions (`reactions.get`, `reaction.set`, `reaction.clear`)

Isaac reacts to chat bubbles (his own or the agent's) on the phone and in Relay desktop, iMessage style: one
emoji per bubble, a new one replaces it, the same one again takes it back. A reaction belongs to a thread
(`assistant:<agent id>` for an assistant's thread across its sessions, `session:<omp session id>` for any
other) and a bubble (`<user|assistant>@<omp timestamp ms>`, the same on every client; row ids are not).
`src/reactions/service.ts` keeps them in `$XDG_CONFIG_HOME/relay/reactions.json` (0600) and sends every
device the thread's `reactions.snapshot { thread, reactions }` on each change; `reactions.get { thread }`
answers the asking device.

Most reactions never start a turn. Three seconds after the last change in a thread, the session running it
(the assistant's live session, or the session itself) gets a quiet note through the bridge (`note { text }`,
which the extension hands to `pi.sendMessage` with `deliverAs: "nextTurn"`: in context from the next turn
on, never displayed): one line per changed bubble, e.g. `[Isaac reacted 👍 to your message: "<first 80
chars>"]`, or `[Isaac removed his 👍 reaction from ...]`. With no live session, or an omp whose bridge
predates notes (it answers without `true`), the changes wait for the next session that takes them. A 👎 or
❓ on an assistant's reply in its own thread is also appended as `{ at, agent, reaction, signal, message:
{ at, excerpt } }` to `<agent home>/work/eva/agents/<id>/reactions.jsonl`.
Exception: a reply-worthy reaction (`RELAY_REPLY_REACTIONS`, comma-separated, default `❓`; `👎` is supported but off) on an
assistant's own reply starts a turn through the thread (`[Isaac reacted ❓ to your message: "..."] He is confused by it:
re-explain it shorter and simpler.`) after a 1.5 s debounce (taking it back inside that cancels; the same emoji on the same
bubble stays quiet for a minute after it fired). A session mid-turn finishes first. That reaction is not also sent as a quiet
note, unless the turn cannot start.

Assistants react to Isaac's bubbles in their own thread with `relay-linux react <emoji> [--agent <id>]
[--message latest|<key>]` or `react --clear` (agent from `$RELAY_ASSISTANT`, `latest` = Isaac's newest
message), which posts `{ agent, emoji?, message?, clear? }` to `POST /reactions/agent` on loopback. A
bubble keeps one reaction per reactor (`isaac` or an agent id), so the snapshot is `reactions[key][reactor]`;
files from before reactors read as Isaac's. An assistant's reaction is only shown: no note, no feedback
line, no turn, no push.

## Open asks (`AssistantSnapshot.asks`, `assistant.ask.resolve`)

Questions waiting on Isaac in an assistant's thread, which the phone shows as small badges above the
composer. Three sources: an assistant row that ends on a `[[replies: a | b]]` token (an optional
`[[ask-label: Short label]]` line right before the token names the badge and is cut from the text with it),
an omp `ask` tool card (its first question; `header` as the label, the option labels as answers), and a
question another omp session puts to him through the thread (`source: "session"`, below).
`src/assistant/ask-store.ts` keeps them per thread in `$XDG_CONFIG_HOME/relay/assistants/<id>.asks.json`
(0600) and every `assistant.snapshot` carries the open ones (`asks`, oldest first, the newest
`MAX_OPEN_ASKS`). The question is the reply's last sentence ending in `?` as plain text (else its last
sentence), and the label is the ask-label or that question cut to `MAX_ASK_LABEL`, without a lead-in
before ": " when the rest stands alone ("Last one for today: want me to ..." reads "Want me to ...").

- An ask closes as `answered` when a device sends `assistant.ask.resolve { agent, id, how: "answered",
  answer? }` (Isaac tapped one of its answers, or typed one on a session ask's card), when a later turn of
  his in the thread is exactly one of its answers (case aside; covers desktop chips and older phones; never
  for a session ask), or when the bridge reports its ask card answered (the extension's
  `ask.resolved { answered }`; a cancel leaves it open). `how: "dismissed"` waves it away. A message typed in
  his own words never closes one: he often answers much later. An id no longer open acks ok.
- The assistant closes one itself with `relay-linux asks resolve <id>... [--answer '<text>']`
  (`POST /assistant/asks/resolve` `{ id, agent?, answer? }` on loopback, 404 for an id that is not open;
  with an answer it closes as `answered`, else `resolved`) and lists them with `relay-linux asks list
  [--agent <id>] [--json]` (`GET /assistant/asks[?agent=<id>]`; agent from `$RELAY_ASSISTANT`, else every
  thread): one line each, `<id>  <agent>  <age>  <label>: <question>  [a | b]`. `relay-linux asks get <id>
  [--json]` (`GET /assistant/asks/<id>`, every thread searched) reads one, open or closed while it is kept:
  state, who asked, the question, the default, the answer and whether it was delivered.
- A row is known by its time and question, not its row id, so an earlier context read back after the
  nightly rollover is the same ask. Asking an open question again refreshes that ask; a closed one asked
  again later is a new ask. Rows older than the file (`since`, set when it is first made) never become asks,
  so an upgrade does not turn the thread's history into badges. Closed asks are pruned after 30 days.

Session asks: any omp session can put a question to Isaac through an assistant's thread without stopping:
`relay-linux asks add --thread nova --from 'Golf' --question 'Book the 7:10 tee time?' --options 'Book it|Skip'
[--default 'Book it'] [--session <id>|me]` (`POST /assistant/asks` `{ thread, from, session?, question,
options, default? }`, answers `{ id }`; the CLI prints just the id). 1 to 8 options of up to 80 characters,
the default one of them, `--thread` from `$RELAY_ASSISTANT` when unset. `--session` (a live session id or a
subagent's, resolved like `canvas join --session`) defaults to the session running the command. The badge
reads `<from>: <question>`. The same question from the same session while it is open refreshes that ask.
Its answers belong to the asking session, so Isaac's turns in the thread never close it; when it closes as
`answered` with an answer (the phone's `assistant.ask.resolve { answer }`, or the assistant relaying a free
answer with `asks resolve <id> --answer`), the host hands `[answer to ask <id>] <answer>` to that session
as a turn (the bridge's `reply`). A failed delivery (the session is gone) is logged and the answer stays on
the ask for `asks get`; a dismissal delivers nothing.

## Bookmarks (`bookmarks.get`, `bookmark.set`)

Turns Isaac marked in the chat's turn navigator (Relay desktop's ticks on the left edge, the phone's rail).
A turn is named by the reaction key of the bubble it starts at (`user@<ms>`, or `assistant@<ms>` for an
assistant that spoke first), and belongs to a thread named like reactions' (`assistant:<id>`,
`session:<omp session id>`). `src/bookmarks/service.ts` keeps one set per thread (oldest first, 500 at most)
in `$XDG_CONFIG_HOME/relay/bookmarks.json` (0600) and sends every device the thread's
`bookmarks.snapshot { thread, messages }` on each change; `bookmarks.get { thread }` answers the asking
device, and a `bookmark.set { thread, message, on }` that changes nothing re-sends the snapshot to its sender
only. Never a turn, a note or a push. The host lists `"bookmarks"` in `welcome.features`; a client on an
older host keeps its bookmarks on the device and sends them up (once) when the feature appears.

## Dismissed status cards (`cards.get`, `card.dismiss`)

The one-row status cards above a chat's composer (canvas Join and wrap-up, sign-in, room ready, guest work,
meeting) that Isaac closed, one set for every device so Relay desktop and the phone agree. A card is named by
the id its client gives it (`canvas:<message id>`, `work:<work id>`, `meeting:<id>`, `room:<id>:ready`,
`signin:<agent>:<message id>`); an id ending `#running` was dismissed while its work ran and the phone shows the
card again once it finishes. `src/cards/service.ts` keeps the set (oldest first, 500 at most) in
`$XDG_CONFIG_HOME/relay/dismissed-cards.json` (0600) and sends every device the whole `cards.dismissed { ids }`
on each change; `cards.get` answers the asking device, `card.dismiss { id, on }` adds (`on`) or removes (undo) an
id, and one that changes nothing re-sends the set to its sender only. Never a turn, a note or a push. The host
lists `"cards.dismissed"` in `welcome.features`; a client on an older host keeps its set on the device and
sends it up (once) when the feature appears.

## Render failures (`render.failed`)

Media in an agent's reply that a client can't show (a broken image, a video the iPhone won't play, a GLB pasted as
markdown) is invisible to the agent, so Relay desktop and the phone report it: on a host whose `welcome.features`
has `"render.report"`, each bubble+src fails once per app run as `render.failed { thread, message, kind, form, src,
error, surface }` (fire and forget). `src/render-failures/service.ts` appends every unique report (thread, bubble,
src, surface) to `$XDG_CONFIG_HOME/relay/render-failures.jsonl` (0600) as `{ at, thread, agent, message, kind, form,
src, error, surface, device: { id, name }, delivered }`, `delivered` being `sent`, `batched`, `capped`, `no-owner`,
`duplicate-message` or `stale`; the tail of the file is read back on start. The bubble's owner (an assistant's
`say`, else the live session as a `[From Relay's background jobs] ` turn) gets one line per bubble, after a 2 s
debounce that batches every failing src: `Render failed on <surface>: <kind> (<form>) <src> (<error>)[; ...] in
your message <key>. Repost it in a working form: ...`. A bubble is told at most once, one older than 2 hours is only
logged (a re-rendered old chat), and a thread gets at most 3 lines per 30 minutes, the third telling the agent to
stop retrying, so a repost loop can't happen.

`share` prints the embed that works for each type (`src/drops/embed.ts`): markdown `![caption](/drops/<id>/<token>)`
for images, video and audio, an openui `Model(...)` block for `.glb`/`.gltf` (stored as `model/gltf-binary` /
`model/gltf+json`), a link for anything else, with a warning for webm or non-H.264 video, ogg/opus audio and
non-GLB 3D. The drop box keeps up to 1000 drops and 2 GB of blobs (`$RELAY_MAX_DROPS`, `$RELAY_MAX_DROPS_MB`) so old
embeds keep loading; devices' Drops lists show the newest 100.

## Artifacts (`artifacts.get`, `artifacts.act`)

What a thread holds, one row per thing however often it comes up: Linear tickets, GitHub PRs and issues,
web links, drops and pasted images, files, Test Bench runs, canvases, branches and subagents. Threads use the
reactions' keys (`assistant:<id>`, `session:<omp session id>`). `src/artifacts/extract.ts` mines a thread's
omp transcripts (Isaac's turns, the agent's replies and a few tool calls; never tool results, custom
messages or the persona prime), and `src/artifacts/service.ts` keeps the result per thread in
`$XDG_CONFIG_HOME/relay/artifacts/<thread>/artifacts.json` (items, mention counts, how far each transcript
was read) and `tabs.json` (the tab bar: Subagents, Links, Media, Everything, then agent tabs). A thread loads on
its first `artifacts.get` or when its session appends messages (read 1.5 s after the last append); its
first read skips transcripts untouched for a week. Running subagents are looked at every 15 s: the last tool
intent in `<session>/<name>.jsonl` is their status line, `<name>.md` ends them, `<name>/<name>.<child>.jsonl`
nests their own subagents.

Every change goes to every device as `artifacts.snapshot { thread, items, tabs }` (`artifacts.get` also
pushes it to every device, so Relay desktop can refresh stale ticket and PR states). `artifacts.act { thread,
rid, by, action }` pins, adds items and tabs, and takes the live states Relay desktop reads from gh and
Linear; the answer is `artifacts.acted { rid, ok, error?, id? }`. Agents may not add a tab that repeats a
default tab or one Isaac hid, and change or remove only tabs they made. Images pasted into a thread are
stored once in `artifacts/media/<sha>` and served at `GET /artifacts/media/<sha>/<token>`.

## Progress estimates (`ActivityItem.eta`, `relay-host eta`)

Every working session and helper in `activity.snapshot` carries `eta` when the host can say how long it has
left (`src/eta/`); every client draws it as the fill behind that run's badge through `etaView` in
`@relay/protocol`. Per poll `EtaService` tails the run's transcript (a session's from the bridge, a helper's
from its item) and estimates the total from three things, blended in log space (`estimate.ts`):

- History: the finished runs in every omp transcript under `~/.omp/agent/sessions` and each profile (last
  120 days, cached per file in `$XDG_CONFIG_HOME/relay/eta-history.json`, read again every 30 minutes). A
  run goes from a request to the reply that ends it; steers and background results stay inside it, and a
  helper's harness nudges do too. A helper (subagent) lives beside its parent's transcript
  (`<session>/<Name>.jsonl`, a lane's own helpers one folder deeper), ends when it calls `yield` (an
  `error` there means it failed), and its role is the agent definition the parent's `task` call gave that
  name (`helper-code`, `helper-visual`, `scout`; `task` when none). An Eva agent session
  (`<agentHome>/work/eva/agent-sessions/*.json`) is one `task` run across its rotated transcripts, from its
  start to its end (a `timeout` ran its whole `--max-time`), with its `--agent` as the role. Runs are
  bucketed by agent (`task`: a session an assistant listed in `work/eva/agents/*/sessions.json`, a job, or
  an agent session; `helper`; `chat`), role, and kind of work from the title (build, fix, research,
  review, render, deploy, prototype). The estimate is the median of similar runs that already lasted
  longer than this one, weighted by 1/length (a run looked at a random moment is more likely a long one),
  so it never reads done while the run goes on; a thin bucket is shrunk toward the agent's whole history.
  Model and thinking level are kept on every run but not bucketed on: held out, they made late estimates
  worse.
- Plan: the run's todo list (`todo` results), else checkboxes in a HANDOFF.md or PLAN.md it wrote or read,
  else its agent session's `--handoff` file, else "step k of n" in its latest reply.
- Pace: turns so far against the turns similar runs took (an agent session counts its earlier rotations).

An agent session's badge runs from the session's own start (not the latest rotation's) and never past its
`--max-time`. Past nearly every similar run (the 90th percentile), `overrunning` is set and the badge says
"Taking longer than usual"; once few similar runs lasted that long, the total is elapsed times how far the
runs past the 90th percentile went on (a Pareto tail fitted per bucket), so it keeps climbing with the
elapsed time and the fill holds steady instead of parking near full.

Solid (`confident`) is earned, not assumed: after each history read, `ConfidenceTable` replays the latest
fifth of runs through an index of the ones before, at ten points along each, and files every estimate's
error by agent, plan or none, and the stage a live badge can see (the plan's share done, else elapsed over
a typical similar run). A badge is solid only in a cell with 20 replays whose median error was under 25%;
everything else draws striped. When a run ends, what was predicted and how long it took go to
`$XDG_CONFIG_HOME/relay/eta-calibration.jsonl`; runs like it (same agent and kind) are stretched or shrunk by
the median actual-over-predicted of the latest 50 once there are 5. `relay-host eta [--json] [--agent-home
<dir>]` prints the accuracy: past runs replayed with the latest fifth held out (confidence learned only from
the runs before it), next to the plain "similar runs take their median" guess, helpers by role, and the live
runs logged. Without `--agent-home` it reads the agent home the host app passes `serve` (host.json's, else
`~/Eva` when it exists), so assistant tasks and agent sessions count as `task` runs there too.

## Live canvas (`canvas.get`, `canvas.open`, `canvas.rooms`, `canvas.access`)

Any omp session takes its chat onto an EvaOS board with `relay-linux canvas start <slug> [--prompt ...]`
(`--title "New board"` makes one; `canvas list`, `canvas end [<slug>]`). The CLI finds its session file from the
ancestor omp process (a subagent's rows go to its top-level chat) and posts loopback `POST /canvas/sessions`.
`POST /canvas/sessions` also takes `thread: {id, page?}`: a comment already in the board file (Relay Desktop's Canvas
page saves pins and threads there without a room, and its "Ask Nova" starts the session this way) that the canvas
self answers in its thread once the room is up, as a turn after the opener's; an answered or missing thread starts none.
The host (`src/canvas/`) opens a room per board: a Y.Doc seeded from `--canvases/<slug>.json` (default on macOS
`~/Library/Application Support/EvaOS/canvases`), y-websocket sync and awareness at `/canvas/<slug>/ws`, a
debounced export back to the same file in EvaOS' exact format, and a watcher that merges outside writes. The
session's agent (its name, color and avatar; its transcript and its assistant's `thread.md` memory as context) is a
full omp agent per room (`src/canvas/brain.ts`, `agent-config.ts`): `omp --mode rpc` on Opus at low effort with a saved
session under `$XDG_CONFIG_HOME/relay/canvas/rooms/<room>/`, working in the agent home with the normal tools (read,
bash, edit, write, grep, glob, task, web_search, browse) and the board as host tools (`canvas_act` runs action
lines as its cursor, `canvas_read` reads cards whole). Its text streams into the bubble at its cursor; while a turn
runs the cursor stays up with a status line (`Presence.doing`: the tool's intent, or "building the mockup…" while it
writes a prototype), a note sent mid-turn is steered into the running turn, and selecting a card makes its cursor
glance there. The guard (`src/canvas/guard.ts`, loaded as the session's only extension) refuses writes outside
`<agent home>/work` and the room's board file, and anything external or in Isaac's name (pushes, GitHub writes,
deploys, publishing, messages, posting data, purchases, his desktop or browser); those go to the chat as
`@handoff main`, where Isaac approves them. Per room it stops at `$RELAY_CANVAS_MAX_TURNS` model requests (150) or
`$RELAY_CANVAS_MAX_TOKENS` (6M), a turn at `$RELAY_CANVAS_MAX_TURN_MIN` (10), and the process idles out after
`$RELAY_CANVAS_IDLE_STOP_MIN` (10, the session resumes on the next note); `$RELAY_CANVAS_MODEL` and
`$RELAY_CANVAS_EFFORT` (low, medium) pick the starting model, and the room's model toggle switches it live.
`GET /canvas/sessions/<room>` reports what it has spent (`usage`).

The page's room bar (top center, always on while the room is live) lists who is here and what each agent is doing:
thinking, editing the board, a tool with its short label, waiting on a handoff, idle, and "done" for a few seconds
after it stops. The host feeds it from more than the turn: once a second it mirrors the bridge session behind the
chat and behind each worker (`join --session`) into `Presence.doing` ("running a command…", "waiting on an
approval…"), so an agent working off the board never reads as idle (`src/canvas/session-activity.ts`).

Isaac comments Figma-style: `/` (or Comment) with a card selected drops a pin on it (it follows the card), else on
the board point, and opens its thread. The thread lives in the doc's `threads` map and the board file's `threads`
(`packages/canvas-live/src/threads.ts`); a human message in one is the canvas self's turn, with the pin's card, spot
and the thread so far as context, and every line it writes in that turn goes into the thread (never a note or a
cursor bubble). `@Name` comments go to that worker with the thread id, and handoffs from a comment confirm in its
thread. Agents also `@reply`, `@pin` and `@resolve`. The side panel lists every thread (open first, resolved
collapsed); the room chat is its second tab. The canvas self wears the face of the assistant its chat belongs to
(its thread, work it started via `owner`, a helper's top session, or `--name <Assistant>`).

Chat rows travel through the bridge's `canvas` request: the extension posts a `relay-canvas` custom message
(`details`: `CanvasEntry` start = Join card, turn = one exchange, end = wrap-up) that lands in the session file
without starting a turn, and phones see it as `AgentMessage.canvas` / `AssistantMessage.canvas`. Devices list
rooms with `canvas.get` (`canvas.rooms` is pushed on every change) and enter with `canvas.open` → `canvas.access
{path, token}`: the token (12 h, multi-use) opens the web client at `/canvas/<slug>/` (built from
`packages/canvas-web`, embedded in the binary), its websocket, `/me`, `/img` and `/end`. The canvas self needs omp on
PATH, in `~/.local/bin`, or `$RELAY_CANVAS_OMP`.

The web client keeps the board tidy unless the room's `settings.tidy` is `false` (the Tidy toggle in its top bar):
cards never overlap and links run orthogonally around cards (`packages/canvas-web/src/route.ts`). A drop is
resolved by the client that dropped it; everything no client owns (the agent's edits, images loading, text
growing) by one elected client, the lowest awareness id among humans whose presence says `tidy: true`, so
clients never fight over a card. Pushed cards keep a 24 px gap and the moves are ordinary doc edits, so they
export to the board file like a drag.

## Live calls (`live.start`, `live.answer`, `live.state`, `live.end`)

"Talk to Nova" (the iPhone Action Button, or Call in a thread) is a GPT-Live call: OpenAI's full-duplex
`gpt-live-1` is the voice, the assistant's own omp session is the brain. The phone sends its WebRTC SDP offer
(`live.start`); the host (`src/live/`) creates the session with `POST /v1/live/sessions` (client delegation)
and answers with OpenAI's SDP (`live.answer`), so the key stays on the host and audio runs phone <-> OpenAI.
The voice starts with a short brief, never the thread (`src/live/brief.ts`, ~300-600 tokens however long the
thread is): headlines of `## About Isaac lately`, `## Promised` and the newest `## Tracking` items of
`<agent-home>/work/eva/agents/<id>/thread.md`, the last four turns, the time and the greeting; the log line
`session ... created` gives its size. The host attaches to the session's sideband
(`/v1/live/sessions/{id}/attach`) and repeats the greeting once `session.started` arrives; on each
`session.delegation.created` it hands Isaac's transcript since the last delegation to the thread as a normal
voice turn (`[Voice call` note, so it shows in the chat and memory), with the voice's question and the words
before it when he was answering a question the voice asked, and returns each settled reply's spoken part
(before `[[details]]`) as `session.commentary.append`. The voice answers greetings, small talk, the time
(the host appends it every minute) and quick general facts itself; everything else, web lookups included,
is delegated (client delegation has no voice-side tools: hosted `web_search` exists only in Responses
delegation, which would take the assistant out of the loop). While the thread works the host sends quiet
progress (`session.thinking.append`). `live.state`
tells the phone `connecting` / `listening` / `thinking` (with the words) / `ended`. The call outlives its
socket; the phone ends it (`session.close` on its data channel + `live.end`), OpenAI drops it, or it is closed
after 30 minutes.

The key is `$OPENAI_API_KEY`, else `OPENAI_API_KEY=` in `<agent-home>/secrets/openai.env`; the voice is
`$RELAY_LIVE_VOICE` (default `marin`). Without a key, or when OpenAI refuses the session, `live.state` `ended`
carries `fallback: true` and the phone starts the local `call.*` call instead. Prove it end to end from the
Mac, against the running host's real thread and without a phone: `bun test/live-smoke.ts --agent nova --ask
"What's on my calendar tomorrow?"` (needs a uv venv with aiortc + numpy, see the file's header).

## Studio (`studio.list`, `studio.req`, `studio.state`, `studio.job`, `studio.removed`, `studio.library`, `studio.segments`, `studio.res`)

An image and video playground for Relay mobile and Relay desktop: the host runs every job, the clients are a
library, a composer and an editor (`packages/protocol/src/studio.ts` is the wire spec). A device asks `studio.list`
and gets `studio.state { jobs, uploads, backends, projects, references }`; after that every job change (created,
every 2 s while it runs, finished, favorited, moved, trashed) goes to every device as `studio.job { job }`, a deleted
job or upload as `studio.removed { id }`, project and reference changes as `studio.library { projects, references }`,
SAM 2.1's objects in an image as `studio.segments { asset, state, segments, error? }`, and a fresh `studio.state`
when uploads or backends change. Everything else is `studio.req { rid, op }`, answered by `studio.res { rid, ok,
error?, job?, jobs?, asset?, project?, reference?, segments?, credits?, balance? }`:

- `create { spec, origin, count?, project?, parent? }`: `count` (1 to 4) separate jobs sharing a `batch`, seeds `s`
  to `s + count - 1` (one paid job at a time); `project` (Unsorted when absent) and `parent { asset, how }` (lineage)
  are kept on each job. Answered with `jobs` and `job` (the first).
- `quote { spec }`, `cancel { id }`, `delete { id }` (a finished job with every copy of its files now, or an
  upload), `upload { image }` (base64, kept as a reference frame), `frame { asset, at: first|last }` (a video's frame
  as a new upload), `refresh`.
- `favorite { assets, value }`, `move { assets, project }` (moves the outputs' jobs), `trash { assets }`,
  `restore { assets }` (within the undo window).
- `project.create { name, id? }` (`id` lets an Undo bring a deleted one back), `project.rename`, `project.delete`
  (its jobs go to Unsorted).
- `reference.create { asset, referenceKind: style|character, name }`: the host's own copy of the image, with its own
  token and thumb, so it outlives the image; its `asset.id` works in `spec.refs`. `reference.delete { id }`.
- `segment { asset }`: SAM 2.1's objects in an image, answered at once with what the host has (a kept result comes
  back `done`); otherwise a run queues for the GPU (ahead of queued jobs, it takes seconds) and its steps arrive as
  `studio.segments` (`queued`, `running`, `done` or `failed`). Each segment's mask (`<id>.mask.png`) and cut-out
  (`<id>.cutout.png`, its `/thumb`) are served under their own token; the result is kept with the image until the
  image goes. A segment's id is a valid `spec.mask` for an edit of that image: the edit runs on the whole image and
  the host then keeps it inside the mask only (`compositeMasked`); a `sam` cutout takes the mask itself.

Local GPU work runs one at a time on this Mac, whoever starts it: the machine-wide lock `~/.cache/eva-gpu.lock`
(`$EVA_GPU_LOCK`, flock(2), shared with draft.py and moss.py) is held by moss.py for MOSS-Image runs, and by the host
itself (`src/studio/gpu-lock.ts`, a tiny Perl helper holding the flock until the host releases it or dies) around LTX,
Kontext, ComfyUI, SAM cutouts and segment runs. While another process holds it, the job reads
"Waiting for the GPU (another job is using it)". For LTX the host holds the real lock and starts draft.py with
`$EVA_GPU_LOCK` on a private file in the job's dir (it would otherwise wait on its own host). Under that lock, before
draft.py starts, ComfyUI's models are unloaded (`POST /free {unload_models, free_memory}` on both ComfyUI servers) and
the Qwen prompt enhancer is stopped (`launchctl bootout gui/<uid>/ai.eva.qwen-local`); after the run, pass or fail,
its plist is bootstrapped again (`src/studio/ltx-memory.ts`; skipped when the plist is absent).

Backends (`src/studio/`), each a runner behind one seam so the tests use fakes:

- `ltx` (free, video): `<agent-home>/work/local-video/draft.py` in its `.venv` (`$RELAY_STUDIO_LTX_DIR` overrides
  the dir) with `--prompt --seconds --res --seed --out` and `--start/--end` (both or neither) plus `--mid PATH@0.5`.
  Homebrew's dirs go first on its PATH (it calls ffmpeg). One job at a time on the GPU, first in first out; queued
  ones say "Waiting for the GPU" with an ETA through the jobs ahead. It runs in its own process group, so a cancel
  SIGTERMs draft.py and ltx-2-mlx together (SIGKILL 5 s later); a failure keeps the last stderr lines.
- `codex-image`, `codex-edit` (free, images, three at once): Codex's image endpoints
  (`chatgpt.com/backend-api/codex/images/generations` and `/edits`, references as JPEG data URLs) on the token
  `omp --profile personal token openai-codex` prints (never logged; omp from PATH or `$RELAY_CANVAS_OMP`). No seeds.
  The endpoints ignore `size` and `quality` (1536x1024 unless the prompt says otherwise), so the prompt sent upstream
  gets one orientation sentence for the aspect ("Vertical 9:16 portrait image, taller than wide.", the job keeps the
  prompt as typed) and ffmpeg scales the reply to cover and center-crops it (lanczos) to exactly the size picked:
  one per aspect, 1088x1920, 1920x1088 or 1280x1280, close to what Codex draws so it never upscales much.
- `moss` (free, local text to image): MOSS-Image on native Apple MLX, run directly (no ComfyUI): `moss.py` in
  `<agent-home>/work/local-higgsfield/moss-mlx` (`$RELAY_STUDIO_MOSS_DIR`) on the moss-image-mlx venv
  (`~/.local/share/moss-mlx/.venv/bin/python`, `$RELAY_STUDIO_MOSS_PYTHON`), one process per image in its own process
  group like LTX; available when both exist and the 8bit tier (`VisualInference/MOSS-Image-SFT-MLX-8bit`) is in the
  Hugging Face cache. Its models: MOSS-Image, plus every MOSS-Image fine-tune on the Mac, a ComfyUI-format checkpoint
  in `local-higgsfield/models/diffusion_models` (recognised by its safetensors keys, e.g. Jib Mix Moss) or a directory
  already converted into `~/.local/share/moss-mlx/transformers/<name>`; read on every refresh and Studio open, so a
  dropped-in checkpoint shows up without a Refresh. Inputs Turbo (on: 15 network passes, about 2 min) and Prompt
  enhancer (local Qwen3); sizes 768x1344, 1344x768, 1024x1024. A run checks the cached files first (about a second; a
  missing one fails with one line naming it and `moss.py --setup`), enhances the prompt, takes the machine-wide GPU lock
  `~/.cache/eva-gpu.lock` (like draft.py; Studio shows the wait), converts a fine-tune on first use (`convert.py`,
  ComfyUI's venv for its int8 dequantizer, no server) and samples (`step i/n` becomes the job's note). ComfyUI is asked
  to unload its models (`/free`) before each run. Shares the GPU queue with LTX, Kontext and ComfyUI.
- `kontext` (free, local image edit, one reference required): FLUX.1 Kontext dev Q8 (`mflux-community/flux-1-dev-kontext-mflux-q8`)
  through `mflux-generate-kontext` from the mflux uv tool (`$RELAY_STUDIO_KONTEXT_BIN` overrides the binary), model read
  offline from the Hugging Face cache; available only when both exist. Sizes 576x1024, 1024x576, 1024x1024; 24 steps,
  guidance 2.5, optional seed. Shares the GPU queue with LTX (one at a time). About 3 min per 1024x576 image and 25 GB
  of RAM: stop the local Qwen server (`ai.eva.qwen-local`) first when memory is tight. Own process group, like LTX.
- `comfyui` (free, images) and `comfyui-video` (free, videos): presets on a ComfyUI server, listed as the backend's
  models (the ComfyUI tab's cards on desktop and the phone). A preset is a folder in
  `<agent-home>/work/local-higgsfield/presets` (`$RELAY_STUDIO_COMFYUI_PRESETS`): `preset.json` (name, description,
  sizes, `refs`/`minRefs`, `prompt: false` for no prompt box, `inputs` (choices and numbers sent as `spec.params`),
  `promptTemplate`, `constants`, `estimateMs`, `family`) beside an API-format `workflow.json` whose values hold
  `{{prompt}}`, `{{seed}}`, `{{width}}`/`{{height}}`, `{{image}}`..`{{image4}}` and each input id. Folders are read on
  every refresh and run, and again (with the server's `/object_info`) whenever a device opens Studio (`studio.list`),
  so a preset folder or a model file dropped in since shows up without a Refresh. A preset is listed only when the
  server has every node class and every model file its workflow names (`/object_info`), so a half-installed one never
  queues; a preset naming one checkpoint file appears the moment that file lands. A job uploads
  its references, posts the graph to `/prompt`, shows the sampler's steps from the websocket, waits on `/history` and
  downloads the first output; a
  cancel deletes it from the queue and interrupts it. Switching to a preset of another `family` first asks the server
  to unload its models (`/free`), and ten idle minutes unload them too, so the Mac's unified memory goes back to LTX,
  Kontext and Qwen. `comfyui` runs on `http://127.0.0.1:8188` (`$RELAY_STUDIO_COMFYUI_URL`) in the GPU queue with
  LTX and Kontext; `comfyui-video` on `http://127.0.0.1:18188` (`$RELAY_STUDIO_COMFYUI_VIDEO_URL`, an ssh tunnel to
  the GPU box's ComfyUI), one job at a time in its own queue. The server keeps its own copies: the local one's
  `output/` and `input/` dirs are `<agent-home>/work/local-higgsfield/ComfyUI/{output,input}`
  (`$RELAY_STUDIO_COMFYUI_OUTPUT`, `$RELAY_STUDIO_COMFYUI_INPUT`). A job deletes its uploads from `input/` when the
  prompt is done and records every file the prompt saved in `output/` (`output/studio/` for the presets) as the
  image's copies, deleted with it; a failed or cancelled job deletes them at once. The video server's dirs are only
  known when `$RELAY_STUDIO_COMFYUI_VIDEO_OUTPUT` / `_INPUT` point at a mount of them.
- `sam` (free, local, one image): SAM 2.1 (`facebook/sam2.1-hiera-large`, transformers format, read offline from the
  Hugging Face cache) on the CPU through a python with torch, transformers and Pillow (`$RELAY_STUDIO_SAM_PYTHON`,
  default `~/.local/share/hades-fit/bin/python`); unavailable with one line when either is missing. Its python lives
  in `sam.ts` as a string, written to a scratch dir per run, in its own process group like LTX. Model `cutout`
  (Remove background, size `source`): the picked segment (`spec.mask`) on a transparent background, or with no mask
  the subject SAM finds. The `segment` op runs the same script: a 16x16 point grid in batches of 64, masks kept when
  confident and stable, deduped by IoU, neither tiny nor nearly the whole picture, the largest
  `MAX_STUDIO_SEGMENTS` first; each a grayscale mask PNG the image's size and an RGBA cut-out cut to its box. SAM
  names nothing, so labels come from shape alone: "Background" (the largest touching three borders or more),
  "Subject" (the large one nearest the middle), else "Object N". About 80 s for a 765x1000 image. In the GPU queue.
- `crop` (free, local, no AI, four at once in its own queue): model `crop`, `params` `x`, `y`, `w`, `h` as fractions of
  the image (each side at least 1%, inside the picture), cut by ffmpeg; JPEG stays JPEG, anything else becomes PNG.
- `higgsfield` (paid, video, two at once): Higgsfield's MCP server with the token omp keeps for its Higgsfield tools
  (`~/.omp/profiles/personal/agent/agent.db`, opened read-only and never refreshed; an expired one makes the backend
  unavailable until an omp session renews it). A curated set of models with their own sizes, lengths and keyframe
  slots; audio off; frames go up through `media_upload`, the job is polled with `job_status`, the mp4 downloaded.

Paid rule: a `create` on a paid backend needs `spec.confirmCredits`, the quote Isaac confirmed with a tap; the host
re-quotes and refuses when the price rose ("The price changed to N credits; confirm again"), refuses `origin:
"agent"` outright, records the charge in `job.credits` and reads the balance again after every paid job.

Files live in `$XDG_CONFIG_HOME/relay/studio/` (dir 0700, files 0600): `index.json` (version 2: jobs and uploads
newest first, projects and references oldest first, segments by image, each file's token and the backend's own
copies elsewhere on disk, the ETA calibration per backend; a version 1 index reads as every job Unsorted with no
projects, references or segments), `<id>.<ext>` per asset and `<id>.thumb.jpg` (ffmpeg, at most 640 px; a video's
first frame). They are served like drops at `GET|HEAD /studio/<id>/<token>` (byte ranges) and
`/studio/<id>/<token>/thumb`, the token checked in constant time. Finished jobs are the library and are never
evicted; past 5000 jobs the oldest failed or cancelled ones go. Up to 100 uploads. A trashed image is hidden and
restorable for 10 minutes (`STUDIO_UNDO_MS`); then a timer (and, for what came due while the host was down, the
start) deletes every copy: the store file and thumb, the backend's copies (ComfyUI's output), its segments' files
and any work dir; a job left with no outputs goes too (`studio.removed`). LTX's `draft-*` temp dirs that a cancelled
or failed run leaves beside draft.py are deleted after it; MOSS, Kontext, Codex, SAM and crop runs write only into
the job's work dir, which is emptied after every run. A job's ETA is its backend's estimate (LTX: 45 s plus a
per-frame-pixel cost on draft.py's generation grid, about 210 s for 5 s at 480x848; Codex 25 s, edits 45 s;
Higgsfield 120 s) scaled by how long jobs really took (a moving average). After a restart running jobs read
"Stopped when the host restarted", queued ones and segment runs run again, and trashed images keep their trash time.

## Assistant instruction files (`assistant.file.req`, `assistant.file.res`)

A desktop that does not run omp itself (Relay Desktop on a MacBook pointed at this host) edits an assistant's
instructions through the host: `assistant.file.req { rid, agent, file: "prime" | "thread", op: "read" | "version" | "save" }`
is answered by `assistant.file.res` with the same rid (`src/assistant/files.ts`). `prime` is
`.omp/assistant/agents/<agent>/prime.md`; `thread` is the agent's thread memory (`work/eva/agents/<agent>/thread.md`,
or `work/agents/<agent>/thread.md` in a starter home), both under the agent home. The frame names an agent from the
registry and one of the two files, never a path, so nothing else is reachable; a file that is missing, or a symlink
out of the agent home, is refused (a save never creates a file). `read` answers `text`, `version { mtimeMs, size,
hash }` (sha1 of the bytes) and the file's absolute `path` on the host; `version` is the same without the text (a poll).
`save` carries `text`, `expectedHash` and `force`, writes tmp + rename, and fails `code: "changed-on-disk"` when the
file no longer has `expectedHash` unless `force`. Saving a prime takes effect on the assistant's next fresh session.

## Remote control (`/control/*`, `control.presence`, `control.req`, `control.res`)

Agents on this Mac (relay-ctl, relay-mcp) drive Relay Desktop on whichever Mac Isaac is using (`src/control/`).
A desktop on a host whose `welcome.features` has `control` sends `control.presence { name, instance, idleMs, page,
focused, remote }` on connect and after input, page and focus changes; the host keeps one entry per socket and turns
`idleMs` into a last-input time on its own clock. "active" is the desktop with the most recent input; with none heard,
the one on this Mac (loopback socket, not remote mode), else the newest connection.

- `GET /control/devices`: `{ok, value: {active, devices: [{id, name, instance, local, lastInputAt, page, focused,
  connectedAt, active}]}}`. A device id is the hello's device id, `:<instance>` appended for builds other than `stable`.
- `POST /control/run {target?: "active" | <id> | <name>, action, params?, confirm?, scope?}` sends `control.req` with a
  fresh rid to that desktop and answers its `control.res` result (the desktop's control API result, plus `device {id,
  name}`), with the desktop API's HTTP statuses. Host failures: `no-device` 404, `device-gone` 502 (it disconnected),
  `device-timeout` 504 (90 s: a destructive action waits up to 60 s for Isaac). `action: "@actions"` is the catalog.

Both need a loopback peer, a loopback `Host`, no `Origin` and `Authorization: Bearer <controlToken>`, the random token
`serve` writes into `serve.json` (0600) at start. `control.req` is a host frame only: a phone or desktop sending one is
a malformed frame, and only the socket a request went to can answer its rid. `features.control: false` in host.json
turns it off.

## Loopback writes: one guard (`src/http-guard.ts`)

A loopback peer proves nothing (any web page open on this Mac can POST to 127.0.0.1), so every state-changing
loopback route runs `guardWrite` in `server.ts` before its handler: `POST /drops`, `/assistant/say`,
`/assistant/asks[/resolve]`, `/assistant/registry` (and its PATCH/DELETE), `/catchup/bounce`, `/reactions/agent`,
`/boards` writes, `/skills` writes, `/canvas/sessions` writes, `/query` and `/control/*`. A write needs a loopback peer
and `Host`; an Origin/Referer, if any, equal to the host's own origin (403 otherwise); `Authorization: Bearer
<controlToken>` from `serve.json` (401; the token exists whether or not `features.control` is on); and the body type the
route takes (415): `application/json` on JSON routes, `text/plain` on `/assistant/say`, anything but a form post on
`/drops`. Callers: the CLI (`hostFetch`; `$RELAY_HOST_TOKEN` beside `$RELAY_HOST_URL` for a second host, which `herdr`
hands down), Relay Desktop (`serveToken`) and Eva's tools read the token from `serve.json`. Token-in-URL rooms and
blobs (`/canvas/<slug>/...`, `/artifacts/media`, `GET /drops/<id>/<token>`) keep their own checks.

## Reviews (`reviews.req`, `reviews.queue`, `reviews.astra`)

What waits on Isaac's reply, on the phone as in Relay Desktop's Reviews page (`packages/protocol/src/reviews.ts` is
the wire spec, `src/reviews/` ports evaos-electron's `main/reviews`). A device asks `reviews.req { rid, op }` and
gets `reviews.res` with the same rid (`ok: false` and a one-line `error` on any failure); the host pushes
`reviews.queue { queue }` to every device whenever a source finishes reading or Done, a snooze or a read mark changes, and
`reviews.astra { item }` (debounced 150 ms) whenever an item's Astra session changes.

Sources, merged newest first into one `ReviewQueue` (a failing source keeps its last rows and sets its `error`):

- GitHub with `gh` (on PATH, else `/opt/homebrew/bin/gh`; launchd gives the host a thin PATH, so children get
  `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` added): open PRs in `eCardSystems` that request his
  review (`needs`) and the ones he reviewed that moved (`reviewing`), cached 60 s. `pr` is `gh pr view --json`
  plus `gh pr diff` (cut at `MAX_REVIEW_DIFF`, `diffTruncated`), pushed commits in the timeline.
- Linear's GraphQL API with `LINEAR_API_KEY` or `<agent home>/secrets/linear.env`, cached 60 s: one row per
  ticket with an unanswered ask from someone else. Images need credentials (Linear's uploads the key, GitHub's
  `user-attachments` gh's login, Slack's files the Slack desktop app's session through its debugging port 9333, read
  only: `files.info` and the file, nothing typed or navigated), so `media.ts` downloads them once into
  `$XDG_CONFIG_HOME/relay/reviews/media/<sha1><ext>` (GitHub's `<img>` tags become Markdown) and the markdown (or a
  Slack message's `attachments[].src`) points at the host-relative
  `/reviews/media/<file>/<token>` (the phone prefixes its host URL). The token is an HMAC of the file name under a
  per-process secret; `GET|HEAD` serves the file only for a matching token, 404 otherwise.
- Slack through headless `claude -p` (`$RELAY_CLAUDE`, `~/.local/bin/claude`, Homebrew's, then PATH) with only the
  claude.ai Slack connector's read tools, `EVA_GATE_OFF=1`, in a throwaway temp dir, 240 s per read, one read at a
  time per thing. The queue and the last 40 threads are kept in `reviews/slack.json`: `queue { refresh: false }`
  answers the last read (and starts the first), `refresh: true` reads again in the background
  (`sources.slack.loading`), pushed when done; `slack { refresh }` answers the kept thread or reads it fresh.

The Guide (`guide`) is written by `claude -p` on Sonnet with no tools from the PR's title, body and diff, kept per
`<repo>#<n>@<headSha>` in `reviews/guides.json` (the newest 40); when that fails the files are grouped by folder.
Done (`done { url, updatedAt, done }`) lives in `reviews/done.json` (0600, url -> `updatedAt`); an item stays hidden
until its `updatedAt` moves past it.

Snooze (`snooze { url, until }`, null wakes it) lives in `reviews/snooze.json` (url -> `until`) and read marks
(`read { url, updatedAt, read }`, `read: false` for Unread) in `reviews/read.json` (url -> the `updatedAt` seen),
both 0600 like done.json; each answers `{ queue }` and pushes it. `queue.snoozed` leaves out snoozes whose time
passed (dropped from the file on the next snooze). A ticket's `activity` is its status changes from Linear's issue
history ("changed status from In QA to Done", or "set status to Todo"; state names in `highlights`), oldest first,
and Astra's turns carry `at` from the transcript (a pending ask, the time he asked) to sit among the comments.

Writes only on an explicit op after Isaac confirmed the text: `comment` and `review` with `gh`, `linearComment`
with the GraphQL API, and `linearUpload { name, mime, data }` (an image for a comment: Linear's `fileUpload`, then
a PUT of the bytes to its signed URL with its headers; answers the `assetUrl` to embed as `![name](url)`).
`slackSend` never posts: it hands `Slack send request: channel=<id> thread_ts=<ts|none>
text=<exact>` to Astra's main thread (`AssistantThread.say`, as `POST /assistant/say` does), and she posts it from
the Slack desktop app. `RELAY_REVIEWS_DRY_RUN=1` makes a test host refuse all five with "Test host: nothing was
posted"; reads stay real.

Astra item sessions (`astraAsk { url, ref, text }`, `astra { url }`): one omp session per item, titled
`Astra · <label>` (`eCardSystems/api#170`, `ENG-6406`, `#ui-ux`), kept in `reviews/astra.json` (url -> title,
session id, session file). The first ask launches it through herdr like a phone-started session, with Astra's
registry profile and model, `RELAY_AGENTS_SOCKET` set to this host's socket and no `RELAY_ASSISTANT` (it is not
her main thread); its first prompt is her prime, her thread memory (`work/eva/agents/astra/thread.md`), the item
(PR, ticket or Slack thread as Markdown) and the question after a marker, so only the question shows as his turn.
Later asks are turns in the live session; once it ended, the next ask resumes its file. The item's turns come
from the provider's conversation while it lives (tool rows one line, notices dropped; `working`, and `waiting`
for an approval or a question) and from the session file after it ended. The host names the session itself (omp
starts with `--no-title`, then `agent.configure { title }` once it joined), as Relay Desktop does. Without an agent
home Astra asks are refused.

One source of truth: the prompts, queries and parsers in `src/reviews/` are ports of evaos-electron's
`apps/desktop/src/main/reviews` (and `renderer/reviews/astra-context.ts` for the item context); a change to a
Slack prompt, the Linear queries, the Guide prompt or the Astra seed goes in both until the desktop reads them
from here. A test host with its own `XDG_CONFIG_HOME` also moves `gh`'s login (`~/.config/gh`): run it with
`GH_CONFIG_DIR=$HOME/.config/gh`.

## Differences from the Mac app

- No tray/menu UI; the terminal is the UI.
- Agent provider is omp only (via the extension above), not Claude Code.
- No TLS (same as Mac v1).
