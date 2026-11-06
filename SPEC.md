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

## The assistant owns the run (assistant threads)

When `@computer` is sent in an assistant's own thread (Nova, Astra, Polaris) and that assistant
answers it (rule 3, or its own name), the run is that assistant at work, not a separate tool: its
omp session plans and speaks, the computer-use loop is its hands. Plain chats, and a run routed to
a different assistant than the thread's, keep the tool flow below with a plan written from the chat.

1. **It plans once, in its own session.** Main sends one background line into the thread through
   Relay (`assistant.turn`, text `[From <Title>'s background jobs] @computer: ...`, a quiet row in
   the chat): the task, the mode, the windows on screen, the ticket when the task names one, and
   the reply shape. The assistant answers in its voice with one short line ("Opening the prototype
   at :5390, three changes to show you") and ends its reply with a fenced `computer-plan` JSON block
   (`run`, `brief`, `app`, `url`, `file`, `intro`, `steps`, `outro`). Main reads the block back from
   the session file (`brief.ts` `planFromSession`, matched by run id); the chat never shows it
   (`@evaos/chat-core/computer-plan`, stripped in the bubble and the assistant's preview).
2. **Its hands are fast.** The loop (low effort) starts as soon as the block lands, with the brief
   and steps in its system context. A walk takes the steps as its step list (no second planning
   call). Live and walk show and speak the plan's `intro`, step `instruction`s and `outro`, which are
   the assistant's own words.
3. **Its questions are its bubbles.** `ask_isaac` and approvals post as plain assistant bubbles in
   the thread (no "Nova:" label), with `[[replies: ...]]` chips where they fit; Isaac's plain reply
   answers them, and they stay in the thread after the run.
4. **It tells Isaac how it went, and remembers.** At the end main sends a second background line
   (`@computer finished (<outcome>): <summary>`, the steps, the picture paths) asking the assistant to
   tell Isaac in one to three sentences. Its reply is the summary bubble, and the run is in its
   context for later turns ("what was on that page?"). The run's own row collapses to "What I did
   (N steps)": task, plan, steps, pictures. If the line cannot be sent, the run posts the summary as
   a plain bubble itself.
5. **Busy or slow.** The plan request is sent only while the thread is idle (Relay status not
   working, waiting or needs_permission), and gets 25 s (`PLAN_WAIT_MS`). Otherwise the planner
   writes the plan from the chat (below) and the run goes on; a late answer from the assistant is
   only its words in the thread.

## Context and plan (every run)

Every run starts from a plan (`main/computer/brief.ts`), shown on its row as a collapsed "Plan:
<first sentence>" that opens to the brief, where, the steps and who wrote it.

- **From the chat** (plain chats, and the assistant-thread fallback): one planner call
  (`plan_run` tool, medium effort) gets the task, the chat's last 30 messages (Isaac's and the
  assistant's text only: tools, thinking, background lines, `(nothing to report)`, reply tokens and
  plan blocks are dropped, each cut to 1500 characters, read from the last 2 MB of the session
  file), the places the chat named (URLs, `localhost:<port>` and "port N" as
  `http://127.0.0.1:<port>`, file paths and bare document names, newest first), the windows on
  screen and the ticket. It writes the same plan the assistant would: a brief of at most 200 words
  (goal, where, what to show or do step by step, the facts it needs), app/url/file, steps, intro,
  outro. A draft chat has no turns: the task is all there is.
- **Models.** Steps: `gpt-6.1-terra`, low effort. Plan: the same model, medium effort. Override
  with `RELAY_COMPUTER_MODEL`, `RELAY_COMPUTER_EFFORT`, `RELAY_COMPUTER_PLAN_MODEL`,
  `RELAY_COMPUTER_PLAN_EFFORT`, or `<config>/computer.json`
  (`{"model", "effort", "planModel", "planEffort"}`); env wins.
- **Walk from a plan.** Opens the plan's `url` (default browser, `open -g`), else its `file`, else
  its `app`, and fronts that window. A step with a `done_when` waits for Isaac as before; a step
  without one (pointing at a change) is shown, said and moved past, so "walk me through the changes
  in the prototype" opens `http://127.0.0.1:5390` and points at each change in order. No steps: the
  walk fails before opening anything.

## Architecture

| Piece                    | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parse `@computer`        | Desktop main, `chat.send` handler, before `SessionManager.send`. Covers typed sends, reply chips and widget replies; the text never reaches omp. Pure parser: `main/computer/command.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Agent loop               | Desktop main (Relay.app's Electron main on the Mini), `main/computer/agent.ts`. Brain: OpenAI Responses API with strict function tools (models above), key from `OPENAI_API_KEY` else `<Eva>/secrets/openai.env`. Instructions carry the plan's brief and steps (`planContext`). Tools: `open_app`, `open_url` (`open -g`, https/http/linear/x-apple.systempreferences only: a Linear issue opens straight at `linear://ecard-systems/issue/<KEY>`, since typing into Linear's search in the background does nothing; local servers like `http://127.0.0.1:5390`), `open_file` (a document by full path or `~/`, `open -g [-a app]`; regular non-executable files only, never apps, scripts, installers or link files), `list_windows`, `read_window` (AX tree as refs, optional screenshot), `act` (a batch: click, type, set_value, key, hotkey, menu, scroll, wait), `ask_isaac` (free-form question, optional reply chips, waits 10 minutes), `finish`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Accessibility            | `cua-driver mcp --direct`, spawned by Relay main as a plain child, so macOS charges it to Relay: Relay's Accessibility and Screen Recording grants (held since d6a6187f, signed with the stable "Relay Local Signing" identity) are the driver's (`check_permissions` reports the host's TCC). Falls back to the CuaDriver.app daemon when Relay lacks them. Headless input is background only: AX actions on element tokens, apps launched with activation suppressed. Live fronts the window for keys, and clicks in front when cua-driver refuses a background click on a picture (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| live / walk presentation | The bundled Assist binary in a new `--present` mode, spawned by Relay main per run (Relay's child, same grants): JSON lines on stdin (`assistant`, `point`, `click`, `caption`, `hide`), events on stdout (`ready`, `landed`, `esc`). It reuses `OverlayController` (teardrop cursor with avatar, ring/outline, caption, click mark, step badge) and `VoiceController` (the assistant's `liveVoice`). No hotkey, no menu item, does not quit the resident Assist. Path: `Relay.app/Contents/Helpers/Relay Assist.app`, `RELAY_ASSIST_BIN` overrides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Walk checks              | The plan's steps are the walk. Each step: the judge picks the control to point at; then the window is re-read every ~0.7 s and Jev (`api.typesafe.ai`, the rooms client) answers "is its done_when true?" (>= 0.85 advances). Without Jev, the model checks every ~2.5 s. Issue keys pull the ticket read-only from Linear into the plan request (its QA steps become the walk).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Chat                     | Main keeps each session's run rows and emits `computer.rows`; they are saved per session file (`<config>/computer/threads/<sha1>.json`, a draft's join its file once it has one), so they survive reloads and restarts. Every row carries `at` (when Isaac sent it) and the chat places each run in its timeline by that (`placeRows`): later messages come below it. While running: Isaac's command, one live progress row ("Planning…" until the plan lands, then the collapsed "Plan: ..." and numbered steps) and approval rows ending in `[[replies: Approve \| Cancel]]` (the tap comes back as a `chat.send` caught while the run waits). While a run waits on Isaac (approval, `ask_isaac`, walk's Keep waiting / Skip / Stop), his next plain message in that chat is the answer, not an omp prompt: it shows under the run's question and goes to the run (words like yes/no answer an approval); `@computer ...` and `/...` messages stay commands, and with nothing waiting a message goes to omp. Finished, plain chat: the command plus one collapsed row, "Astra · @computer: <answer>", that opens to the task, plan, steps and pictures (local PNGs under `<config>/computer/<run>/`). Finished, assistant thread: "What I did (N steps)" collapsed, its questions kept, and the assistant's own reply as the summary (see "The assistant owns the run"). |
| MacBook                  | A thin client (remote mode) answers "@computer runs on the Mac Mini" and does nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Windows without controls, and keys

- **Vision fallback.** Some apps draw their own UI (Bambu Studio's wx/OpenGL window: "Slice plate",
  "Print plate", its tabs) and answer an empty tree, or only the menu bar and window chrome
  (`desktop.ts` `drawnOnly`). Their read comes with the window's picture, and `act` takes a click
  by `target` (what the control shows) instead of `ref`. A target that is exactly a control's label
  still goes through Accessibility (`clickTarget`); otherwise a fresh picture
  (`get_window_state` without the tree) goes to the locator (`locate.ts`, one model call with the
  picture: the box and the text it shows there), the gate judges the target and that text like a
  label, the cursor glides to the box's centre (live), cua-driver clicks those pixels (through the
  picture's `capture_id`), and a fresh picture after says whether the window changed and goes back
  to the model. The click is posted in the background first; cua-driver refuses that for windows
  it cannot resolve (Bambu Studio's), and live then clicks for real in front (a refusal delivered
  nothing, so it never clicks twice). Headless stops there and says to run it live. Walk points
  at the step's target found the same way when the window has no control to pick.
- **Keys go where Isaac would see them.** A key or chord goes to the panel in front of the named
  window when one is up, else to the window (`keyWindow`). Panels come from WindowServer's window
  list at every level (`MAC_SCREEN`, JXA over AppKit and CoreGraphics, ~0.1 s): cua-driver lists
  level-0 windows only, and Quick Look floats at level 3 while Finder is active. Live fronts the
  app first unless it is frontmost already (raising its window again would take the keys from its
  panel). 2026-11-06: Down and Right posted to Finder's browser window while Quick Look was open
  were refused by cua-driver (`same_pid_keyboard_ambiguity`: Finder owned a second window, the
  panel), so Quick Look never stepped; live now sends a key refused that way to the app itself,
  whose key window in front (the panel) takes it, while headless keeps the refusal. After each key
  the app's windows (every level) and the key window's picture (`screencapture -l`: a cua-driver
  capture is a new snapshot and would stale the refs the rest of the batch uses) are compared,
  and the step says "the windows changed", "the window changed" or "NOTHING CHANGED", so the
  model stops repeating a key that does not land.

## Safety

- Anything that sends, posts, deletes, buys, pays, submits, publishes, shares, invites, accepts,
  prints or signs out asks Isaac in the chat first, with the window's picture and one line of what will
  happen. Enforced in code, not only in the prompt (`main/computer/safety.ts`): an `act` batch with
  a risky control label, menu item, typed text or keys in a messaging app, or Cmd+Delete/Cmd+Return
  stops and asks before anything in it runs. Cancel or 10 minutes without an answer runs nothing.
- Messaging apps (Messages, Slack, Teams, Outlook, Mail, Discord, WhatsApp, Signal, Telegram): no
  typing or keys without approval; never a name plus Return in one batch.
- Never types into a secure text field; a login stops the run and says so.
- System Settings switches and checkboxes are not pressable unless the task says to change that
  control (a change verb and its label), after the 2026-11-03 Relay toggle incident.
- Headless never fronts a window, warps or clicks the real mouse. live/walk front only the target
  window (Isaac asked to watch). Esc on the overlay stops the run.
- Budgets: 30 actions, 6 minutes (walk: 3 minutes per step, then "Keep waiting / Skip / Stop").
  Every run logs `[computer]` lines to Relay's main log; pictures go to `<config>/computer/<run>/`.

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
   In assistant threads the plan reply, the summary and the result already live in the session.
2. The phone shows an assistant's `computer-plan` block as a code block (the host's transcript
   reader does not strip it yet). Strip it on the host too? (Host install.)
3. A hidden side request (`btw`-style, no visible turn) needs a host bridge request; today the plan
   request and the report are background lines (quiet rows) and the assistant's replies are visible.
4. Phone: allow `@computer` from the phone to drive the Mini headless (approvals on the phone)?
5. "Walk me through ENG-6810": walk its QA steps in the browser (Arc on staging), or tour the
   ticket in Linear? v1 walks the QA steps when the ticket has them.
6. Retire the hotkey entirely once walk covers lessons, or keep "where is X" on it?
