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

Reactions never start a turn. Three seconds after the last change in a thread, the session running it
(the assistant's live session, or the session itself) gets a quiet note through the bridge (`note { text }`,
which the extension hands to `pi.sendMessage` with `deliverAs: "nextTurn"`: in context from the next turn
on, never displayed): one line per changed bubble, e.g. `[Isaac reacted 👍 to your message: "<first 80
chars>"]`, or `[Isaac removed his 👍 reaction from ...]`. With no live session, or an omp whose bridge
predates notes (it answers without `true`), the changes wait for the next session that takes them. A 👎 or
❓ on an assistant's reply in its own thread is also appended as `{ at, agent, reaction, signal, message:
{ at, excerpt } }` to `<agent home>/work/eva/agents/<id>/reactions.jsonl`.

Assistants react to Isaac's bubbles in their own thread with `relay-linux react <emoji> [--agent <id>]
[--message latest|<key>]` or `react --clear` (agent from `$RELAY_ASSISTANT`, `latest` = Isaac's newest
message), which posts `{ agent, emoji?, message?, clear? }` to `POST /reactions/agent` on loopback. A
bubble keeps one reaction per reactor (`isaac` or an agent id), so the snapshot is `reactions[key][reactor]`;
files from before reactors read as Isaac's. An assistant's reaction is only shown: no note, no feedback
line, no turn, no push.

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

## Live canvas (`canvas.get`, `canvas.open`, `canvas.rooms`, `canvas.access`)

Any omp session takes its chat onto an EvaOS board with `relay-linux canvas start <slug> [--prompt ...]`
(`--title "New board"` makes one; `canvas list`, `canvas end [<slug>]`). The CLI finds its session file from the
ancestor omp process (a subagent's rows go to its top-level chat) and posts loopback `POST /canvas/sessions`.
The host (`src/canvas/`) opens a room per board: a Y.Doc seeded from `--canvases/<slug>.json` (default on macOS
`~/Library/Application Support/EvaOS/canvases`), y-websocket sync and awareness at `/canvas/<slug>/ws`, a
debounced export back to the same file in EvaOS' exact format, and a watcher that merges outside writes. The
session's agent (its name, color and avatar; its transcript as context) runs on a warm
`omp --mode rpc --no-tools --thinking off` brain that streams board actions as a line DSL, typed into the doc as
CRDT ops while tokens arrive; the opener is precomputed so it plays the moment Isaac joins.

Chat rows travel through the bridge's `canvas` request: the extension posts a `relay-canvas` custom message
(`details`: `CanvasEntry` start = Join card, turn = one exchange, end = wrap-up) that lands in the session file
without starting a turn, and phones see it as `AgentMessage.canvas` / `AssistantMessage.canvas`. Devices list
rooms with `canvas.get` (`canvas.rooms` is pushed on every change) and enter with `canvas.open` → `canvas.access
{path, token}`: the token (12 h, multi-use) opens the web client at `/canvas/<slug>/` (built from
`packages/canvas-web`, embedded in the binary), its websocket, `/me`, `/img` and `/end`. Brains need omp on
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
(`live.start`); the host (`src/live/`) creates the session with `POST /v1/live/sessions` (client delegation,
the end of the thread and the time as startup input) and answers with OpenAI's SDP (`live.answer`), so the
key stays on the host and audio runs phone <-> OpenAI. The host attaches to the session's sideband
(`/v1/live/sessions/{id}/attach`); on each `session.delegation.created` it hands Isaac's transcript since the
last delegation to the thread as a normal voice turn (`[Voice call` note, so it shows in the chat and memory),
and returns each settled reply's spoken part (before `[[details]]`) as `session.commentary.append`. The voice
answers greetings, small talk and the time itself (the host appends the time every minute); everything else
is delegated. While the thread works the host sends quiet progress (`session.thinking.append`). `live.state`
tells the phone `connecting` / `listening` / `thinking` (with the words) / `ended`. The call outlives its
socket; the phone ends it (`session.close` on its data channel + `live.end`), OpenAI drops it, or it is closed
after 30 minutes.

The key is `$OPENAI_API_KEY`, else `OPENAI_API_KEY=` in `<agent-home>/secrets/openai.env`; the voice is
`$RELAY_LIVE_VOICE` (default `marin`). Without a key, or when OpenAI refuses the session, `live.state` `ended`
carries `fallback: true` and the phone starts the local `call.*` call instead. Prove it end to end from the
Mac, against the running host's real thread and without a phone: `bun test/live-smoke.ts --agent nova --ask
"What's on my calendar tomorrow?"` (needs a uv venv with aiortc + numpy, see the file's header).

## Differences from the Mac app

- No tray/menu UI; the terminal is the UI.
- Agent provider is omp only (via the extension above), not Claude Code.
- No TLS (same as Mac v1).
