# @computer: Relay's own computer-use agent (v1)

Isaac types `@computer <task>` in a Relay Desktop chat on the Mac Mini. Relay runs its own agent loop
on the Mini that drives his real, signed-in apps through Accessibility, posts progress into that chat
and ends with a summary. It replaces Relay Assist's hotkey bubble and separate brain as the way to
get computer use; Assist's overlay becomes the presentation layer for `live` and `walk`.

## Modes and grammar

```
@computer <task>            headless (default): background, no mouse, no focus change
@computer live <task>       same agent, but Assist's cursor glides to each control and clicks
@computer walk <task>       walkthrough: point, caption, speak; Isaac does the step; advance when done
@computer stop | next | skip    control the run in this chat (next/skip: walk only)
```

- Only at the very start of a message, case-insensitive. The keyword must be the first word after
  `@computer`; anything else is the task (`@computer liven up the doc` is headless). `walk me through
  X` and `walk through X` keep the words: the task is `X`.
- `@computer` alone, or `help`, answers with the grammar. One run at a time on the Mini.
- Screenshots on request: a task that says screenshot, show me or picture gets the final window
  picture in the summary (and every step's with "screenshot each step"). Approvals always show one.

## Who answers

Same rules as Assist (`apps/assist/README.md`, Assistant.swift `decide`), evaluated in main:
1. a name in the task wins ("Astra, ..." / "..., Nova" / "ask Astra ..."), and is removed from it;
2. eCard in the task: an issue key (`ENG-6810`), PR, pull request, "ecard", or an eCard repo name
   (Assist's cached `~/Library/Caches/RelayBuddy/ecard-repos.txt`): Astra;
3. the chat is an assistant's thread: that assistant;
4. otherwise Nova.
Who answers sets the name on the chat rows and, in live/walk, the cursor, colours and `liveVoice`.

## Architecture

| Piece | Where |
|---|---|
| Parse `@computer` | Desktop main, `chat.send` handler, before `SessionManager.send`. Covers typed sends, reply chips and widget replies; the text never reaches omp. Pure parser: `main/computer/command.ts`. |
| Agent loop | Desktop main (Relay.app's Electron main on the Mini), `main/computer/agent.ts`. Brain: OpenAI Responses API with strict function tools (`gpt-6.1-terra`, low effort, as Assist; `RELAY_COMPUTER_MODEL`), key from `OPENAI_API_KEY` else `<Eva>/secrets/openai.env`. Tools: `open_app`, `list_windows`, `read_window` (AX tree as refs, optional screenshot), `act` (a batch: click, type, set_value, key, hotkey, menu, scroll, wait), `ask_isaac`, `finish`. |
| Accessibility | `cua-driver mcp --direct`, spawned by Relay main as a plain child, so macOS charges it to Relay: Relay's Accessibility and Screen Recording grants (held since d6a6187f, signed with the stable "Relay Local Signing" identity) are the driver's (`check_permissions` reports the host's TCC). Falls back to the CuaDriver.app daemon when Relay lacks them. Background input only: AX actions on element tokens, apps launched with activation suppressed. |
| live / walk presentation | The bundled Assist binary in a new `--present` mode, spawned by Relay main per run (Relay's child, same grants): JSON lines on stdin (`assistant`, `point`, `click`, `caption`, `hide`), events on stdout (`ready`, `landed`, `esc`). It reuses `OverlayController` (teardrop cursor with avatar, ring/outline, caption, click mark, step badge) and `VoiceController` (the assistant's `liveVoice`). No hotkey, no menu item, does not quit the resident Assist. Path: `Relay.app/Contents/Helpers/Relay Assist.app`, `RELAY_ASSIST_BIN` overrides. |
| Walk checks | Each step: one model call picks the control to point at and the observable "done when"; then the window is re-read every ~0.7 s and Jev (`api.typesafe.ai`, the rooms client) answers "is it done?" (>= 0.85 advances). Without Jev, the model checks every ~2.5 s. Issue keys pull the ticket read-only from Linear (its QA steps become the walk). |
| Chat | Main keeps the rows of each pane's runs and emits `computer.rows`; the chat shows them after the session's messages (like the avatar editor's local rows). One live progress row (numbered steps), then a summary row. Images are local PNGs under `<config>/computer/<run>/` shown as markdown images. Approval rows end in `[[replies: Approve \| Cancel]]`; the tap comes back as a `chat.send` caught while the run waits. |
| MacBook | A thin client (remote mode) answers "@computer runs on the Mac Mini" and does nothing. |

## Safety

- Anything that sends, posts, deletes, buys, pays, submits, publishes, shares, invites, accepts or
  signs out asks Isaac in the chat first, with the window's picture and one line of what will
  happen. Enforced in code, not only in the prompt: an `act` batch with a risky control label, menu
  item, typed text in a messaging app, Return in a messaging app or Cmd+Delete/Cmd+Return is refused
  unless `ask_isaac` for it was approved. Cancel or 10 minutes without an answer ends the run.
- Messaging apps (Messages, Slack, Teams, Outlook, Mail, Discord, WhatsApp, Signal, Telegram): no
  typing or keys without approval; never a name plus Return in one batch.
- Never types into a secure text field; a login stops the run and says so.
- System Settings switches and checkboxes are not pressable unless the task says to change that
  control (a change verb and its label), after the 2026-11-03 Relay toggle incident.
- Headless never fronts a window, warps or clicks the real mouse. live/walk front only the target
  window (Isaac asked to watch). Esc on the overlay stops the run.
- Budgets: 30 actions, 6 minutes (walk: 3 minutes per step). Every run logs to
  `<config>/computer/<run>/run.jsonl`.

## What changes in Assist

- Added: `--present` (the overlay and voice as a driven presentation layer).
- Cut from the computer-use path: the prompt bubble as the entry point, Brain.swift's own do-it,
  chores, lessons planning and plan cache. `@computer` owns planning, acting, approvals and the record
  in the chat.
- Decision on the hotkey: it stays in v1 as a secondary entry point for quick "where is X" pointing
  (no chat, no actions), unchanged. When `@computer walk` covers lessons, the hotkey's do-it, chores
  and lessons go and the bubble forwards anything else into `@computer` in the assistant's thread.

## Open questions for Isaac

1. Rows live in the desktop only (not the session file, not the phone). Persist them as a
   `relay-computer` custom message through the host so the agent and phone see them? (Host install.)
2. Should the chat's own agent hear the summary (one quiet line into its context) so "what did
   @computer find?" works?
3. Phone: allow `@computer` from the phone to drive the Mini headless (approvals on the phone)?
4. "Walk me through ENG-6810": walk its QA steps in the browser (Arc on staging), or tour the
   ticket in Linear? v1 walks the QA steps when the ticket has them.
5. Retire the hotkey entirely once walk covers lessons, or keep "where is X" on it?
