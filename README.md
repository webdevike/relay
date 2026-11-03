# Relay Assist (prototype; repo and binary still named relay-buddy / RelayBuddy)

A macOS menu-bar helper for learning apps. Tap **Control+Option+Space** to type a question, or
hold it to ask by voice. The answer comes from one of Isaac's assistants: **Nova** (personal) or
**Astra** (eCard work). Her cursor (a teardrop in her accent colour with her avatar in the head and
her name on the tag) glides to the control, pulses a ring on it, shows a one-line caption (and
says it in her voice), then fades about 2 seconds later. It does small chores for you (switching a
mode, opening a menu) with an Undo pill, does the step itself only when you say "do it", and runs
short lessons ("teach me to ...") that move on when you finish each step.

## Assistants and routing

- **Identity**: `Sources/Assistant.swift` reads the registry Relay reads,
  `~/Eva/.omp/assistant/agents.json` (`RELAY_ASSIST_REGISTRY` overrides): title, `liveVoice`,
  and the designed avatar (DiceBear style, seed, part options, `colors.paper`/`colors.accent`).
  Avatars are drawn once with Relay's own DiceBear packages (`tools/render-avatar.ts`, the same
  call as Relay's `portraitSvg`, run with bun against `$RELAY_DIR`, default `~/Eva/work/relay`),
  rasterized on the paper disc and cached in `~/Library/Caches/RelayBuddy/avatars/`.
- **Who answers** (local rules, no model call), logged as `route=agent:<id> reason=...`:
  1. a name in the question ("Nova, where is Wi-Fi", "... , Astra?", "ask Astra ...") wins, and
     the name is removed from the question;
  2. eCard on screen: Linear in front, or a Slack, Chrome or Arc window whose title or address
     bar shows eCard (the eCard Platform Slack workspace, `ecardsystems`, `github.com/eCardSystems`,
     or one of the org's hyphenated repo names, listed with `gh repo list eCardSystems` once a day
     into `~/Library/Caches/RelayBuddy/ecard-repos.txt`): Astra;
  3. eCard in the question: an issue key (`ENG-6309`), "PR", "pull request", "ecard" or an eCard
     repo name: Astra;
  4. otherwise Nova.
  The bubble shows the likely assistant from the screen when it opens (`stage=summon`); the
  question decides on Return (`stage=ask`).
- **Voice**: she speaks in her registry `liveVoice` (Nova `marin`, Astra `ballad`), the voice
  name Relay's GPT-Live calls use, through the existing `/v1/audio/speech` path. There is no
  separate voice setting any more. Transcription is unchanged.
- **Shortcuts** (no brain, logged `path=shortcut`): "open/show/go to ENG-6309" opens the issue
  in the Linear app (`linear://ecard-systems/issue/ENG-6309`, else linear.app), waits for Linear
  to show it, and points at the issue's title (read through the read-only Linear hook).
  "open PR 123" in an eCard repo (named in the question, or the GitHub page in front) opens the
  URL `gh pr view` reports in the default browser; a pasted PR URL opens directly.

## Proof videos

- `proof/assistant-cursor.mp4` (`tools/record-assistant.sh`): one hotkey, four asks. Blender
  "where is the bevel tool" (Nova, orange); Finder "open ENG-6309" (Astra, blue, Linear opens by
  shortcut and she points at the title); Linear "what is this ticket?" (Astra explains it);
  System Settings "Nova, where is Wi-Fi" (Nova by name). Recorded with voice off.

Phase 2 (phone-friendly 1280x720, cropped around the action; recorded before the assistants, so
the cursor there is the old blue "Buddy"):

- `proof/phase2-chore.mp4`: "how do I bevel?" in Object Mode. Buddy switches to Edit Mode for
  you (dotted trail, click, "Undo · Switched to Edit Mode for you"), looks again, and points at
  the Bevel tool.
- `proof/phase2-doit.mp4`: "bevel it for me". Buddy bevels the cube, shows Undo, and the Undo
  pill is pressed: the cube goes back to sharp edges ("Undone").
- `proof/phase2-lesson.mp4`: "teach me to start a donut: add a torus, scale it up, shade it
  smooth". Step pill, a point per step, and each step advances when Blender shows it done.

Phase 1: `proof/relay-buddy-phase1.mp4`, `proof/bevel-closeup.mp4`, `proof/contact-sheet.jpg`
and single-question clips.

## Build and run

```sh
./build.sh                       # swiftc build into build/RelayBuddy.app, signed with the local
                                 # Apple Development identity when present (stable privacy grants)
open build/RelayBuddy.app        # menu-bar app, no Dock icon
make test                        # or ./build.sh test: behaviour tests in Tests/main.swift
```

The tests cover the rules decided without a model or the screen: who answers (names, issue keys,
the Linear app rule), the open-by-key shortcuts, "what can you do here?", handoff intents,
plan-cache trust (saved only once used without Undo, deleted on Undo after a replay, `--forget`)
and lesson checks (one step at a time, a check already true at step start never ticks it off).
They use a temp registry, plan store and log (`RELAY_BUDDY_LOG`).

The OpenAI key comes from `OPENAI_API_KEY`, else `/Users/ike/Eva/secrets/openai.env`
(override the path with `RELAY_BUDDY_ENV_FILE`). Model: `gpt-6.1-terra` (`RELAY_BUDDY_MODEL`),
reasoning effort `low` (`RELAY_BUDDY_EFFORT`). `RELAY_BUDDY_SPEAK=0` keeps Buddy quiet;
`RELAY_BUDDY_HOOKS=none` turns off app hooks (default `blender`). Voice settings are in
`Sources/Voice/README.md`.

Scripted use, for tests and for other apps such as Relay:

```sh
B=build/RelayBuddy.app/Contents/MacOS/RelayBuddy
$B --send "where is the bevel tool?" --target Blender   # ask the running Buddy
$B --send "where is loop cut? stay"                     # "stay" keeps Buddy up until Esc or a click
$B --send "bevel it for me" --target Blender            # do-it mode
$B --send "teach me to start a donut" --target Blender  # lesson; then --send next|skip|stop
$B --undo                                               # press the Undo pill
$B --summon                                             # same as tapping the hotkey
$B --ask "question" [--target app]                      # start Buddy and ask once it is up
$B --voice-test q.m4a                                   # transcribe a file (no mic needed)
```

`--target` takes an app name or bundle id. Without it Buddy looks at the frontmost app, skipping
system surfaces (login window, Dock, Spotlight, Control Center) and falling back to the last real
app that was frontmost. A newly started Buddy tells any older instance to quit.

## How it behaves

- **Hotkey**: Carbon `RegisterEventHotKey` (no permission needed). A tap under 0.3 s opens the
  typed bubble; holding it listens and the live transcript fills the bubble.
- **Prompt bubble**: a non-activating panel at the cursor, so the app you are learning stays
  frontmost. Drag it anywhere; Esc, the close button or a click elsewhere closes it. Buddy
  captures the window while you type.
- **What Buddy sees**: the frontmost window of the target app (ScreenCaptureKit, up to 3840 px),
  a trimmed accessibility tree, and, for apps with a hook, live state from the app itself.
- **Model call**: OpenAI Responses API with strict tools `say`, `point`, `highlight`, `do` and
  `done`, in one parallel turn. The last screenshot, prompt and response land in
  `~/Library/Caches/RelayBuddy/last/`.
- **Chores** (`do` with `core_step: false`): steps on the way that are not the thing being
  learned, like switching to Edit Mode before beveling. Buddy glides along a dotted trail to where
  the chore happens, shows a click, announces it ("Switched to Edit Mode for you") and shows an
  Undo pill that names it. Then it captures again and points at the real target.
- **Do it** (`core_step: true`): only when the question asks for it ("do it", "for me", "can you
  ..."). Buddy refuses a core step otherwise and teaches it by pointing. After doing it, Buddy
  stays 4 s (instead of 2 s) so the Undo pill is reachable, and hovering the pill holds it.
- **Undo**: through the app hook when there is one (Blender: steps `bpy.ops.ed.undo()` back until
  the scene's fingerprint matches the state before Buddy acted), else Cmd+Z to the app.
- **Lessons**: "teach me to X" plans 2 to 5 steps (the user's own list when given), shows a small
  "Step 2 of 3 · Scale it up" pill by the cursor that hides itself, points at each step, and
  checks about once a second whether the step is done: a hook expression (Blender, for example
  `obj is not None and obj.name.startswith('Torus')`), or any change in the window's AX tree for
  apps without a hook. Type or say `next`/`skip` to move on, `stop` to end.
- **What can you do here?** (also "help"): a template answer, no model call, built from what is
  wired for the app in front (its hook, Jev navigation, the open-by-key shortcuts, lessons,
  handoffs): a few spoken sentences, one caption line and two things to try (`Sources/Capabilities.swift`).
- **Overlay**: transparent, click-through, on every Space, never key. Any click (it still reaches
  the app) or Esc dismisses Buddy at once and stops speech. The Undo pill is the one clickable
  piece, a separate non-activating panel.
- **Voice** (`Sources/Voice`, built by BuddyVoice): streaming transcription while the key is
  held, spoken captions that stop the moment you dismiss Buddy or ask again.
- **Log**: `~/Library/Logs/RelayBuddy.log` (timings, tool calls, chores, undo, lesson progress).

## App hooks

`Sources/Hooks.swift` defines `AppHook`: scene state for the prompt, actions, a state snapshot
for undo, and lesson checks. `BlenderHook` talks to the MCP for Blender add-on's socket
(`127.0.0.1:9877`, `BLENDER_PORT`), the same add-on `.omp/mcp.json`'s `blender` server uses, by
sending `execute_code`. It reports mode, workspace, active tool, active object (vertices, faces,
shading, scale), selection and the object list, and runs the model's `blender_python` actions
inside a 3D Viewport context override. Apps without a hook act through cua-driver (`click`,
`press_key`/`hotkey`, `invoke_menu`).

## Permissions

| Feature | Needs |
| --- | --- |
| Hotkey, bubble, overlay, Undo pill, click-to-dismiss | nothing |
| Screenshot of the window | Screen Recording, or the running cua-driver daemon |
| Accessibility tree, Esc-to-dismiss while another app is frontmost | Accessibility, or cua-driver for the tree |
| Chores and do-it in Blender | the MCP for Blender add-on running in Blender |
| Chores and do-it in other apps | the running cua-driver daemon |
| Voice questions | Microphone (asked the first time you hold the hotkey) |

Buddy never asks for Screen Recording or Accessibility by itself. It picks a capture path at
launch: **native** (ScreenCaptureKit + AX in process) when it holds Screen Recording, else
**cua-driver** (`cua-driver call get_window_state` against the authorized CuaDriver daemon; start
it with `open -n -g -a CuaDriver --args serve`).

To give it its own grants: choose **Give Relay Assist Its Own Permissions…** in its menu-bar menu,
then in System Settings > Privacy & Security turn on **Relay Assist** (bundle `com.relay.buddy`,
so grants made under the old name carry over) under **Screen & System
Audio Recording** and **Accessibility**, and relaunch it. For voice: System Settings > Privacy &
Security > **Microphone** > **Relay Assist** (or answer the prompt the first time you hold the key).

## Tests and proof

```sh
tools/record-assistant.sh                  # assistant cursor proof: hotkey asks routed to Nova/Astra (tools/assist-cut.py cuts it)
tools/record-phase2.sh chore|doit|lesson   # Phase 2 proofs (resets Blender's scene before and after)
tools/record-proof.sh                      # Phase 1 proof
tools/prooftest.sh "where is the bevel tool?" Blender proof/blender-bevel.mov 16
tools/blender.py --state | --reset | 'python code'   # poke Blender through the add-on socket
tools/voice-test.sh stt|tts|barge          # voice checks (Sources/Voice/README.md)
```

`tools/proofrec.swift` records the main display with ScreenCaptureKit, keeping only the windows
of the given processes (target app + Buddy). It works while the Mac is locked, where
`screencapture -v` records only the lock screen. In the lesson proof, `tools/blender.py` does
each step in place of the user.

- Chore: "how do I bevel?" in Object Mode switched to Edit Mode (one `mode_set`), then pointed at
  the Bevel tool icon. About 10 s end to end: 4.9 s to the first plan (capture included), the
  chore itself in 0.05 s, then a second capture and a 2.7 s plan.
- Do it: "bevel it for me" beveled the cube's edges through `bpy` (switching to Edit Mode on the
  way); pressing Undo stepped back until the scene matched the original cube in Object Mode.
- Lesson: three steps planned exactly as listed, each detected done within about 1 s and
  advanced; ended with "Nice, you did it".
- Voice: `RelayBuddy --voice-test` on a spoken file transcribed "Where is the bevel tool?" in
  1.5 s.

## Layout

- `Sources/main.swift`: CLI flags, app start.
- `Sources/AppDelegate.swift`: menu bar, hotkey and voice, target choice, routing to an assistant,
  shortcuts, ask, chore and do-it flow.
- `Sources/Assistant.swift`: the assistant registry, avatar drawing and cache, `AssistantRouter`
  (who answers), eCard repo list from gh.
- `Sources/Shortcuts.swift`: no-brain opens (Linear issue, GitHub PR).
- `Sources/PromptBubble.swift`: the question bubble.
- `Sources/Capture.swift`, `Sources/CuaDriver.swift`: screenshot, AX tree, cua-driver calls.
- `Sources/Brain.swift`: Responses API calls, tool schemas, lesson planning.
- `Sources/Hooks.swift`: `AppHook`, `BlenderLink`, `BlenderHook`.
- `Sources/Actions.swift`: `do()` actions, the do-it permission check, the executor and undo.
- `Sources/Lesson.swift`: lessons.
- `Sources/Overlay.swift`, `Sources/OverlayExtras.swift`, `Sources/BuddyCharacter.swift`:
  overlay, the assistant's cursor, rings, click trail, step pill, Undo pill.
- `Sources/Voice/`: voice input and output.

## Next

- **Relay memory**: send each question, app, answer and lesson progress to Relay Host so Buddy
  remembers what the user already learned and adapts its hints.
- **Blender layout from the add-on**: region and toolbar rects from `bpy` so Buddy aims at
  icons without relying on vision alone.
- **Chores inside lessons**: lessons drop `do()` today; allow chores there with the same Undo.
- **Generic undo**: Cmd+Z is a guess for apps without a hook; record and reverse cua-driver
  actions (close the menu it opened, restore the tab it switched).
