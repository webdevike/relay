# Relay Buddy (prototype)

A macOS menu-bar helper for learning apps. Tap **Control+Option+Space** to type a question, or
hold it to ask by voice. Buddy, a small blue cursor with a face and a "Buddy" name tag, glides to
the control, pulses a ring on it, shows a one-line caption (and says it), then fades about
2 seconds later. It does small chores for you (switching a mode, opening a menu) with an Undo
pill, does the step itself only when you say "do it", and runs short lessons ("teach me to ...")
that move on when you finish each step.

## Proof videos

Phase 2 (phone-friendly 1280x720, cropped around the action):

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
```

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

To give Buddy its own grants: choose **Give Buddy Its Own Permissions…** in its menu-bar menu,
then in System Settings > Privacy & Security turn on **Relay Buddy** under **Screen & System
Audio Recording** and **Accessibility**, and relaunch it. For voice: System Settings > Privacy &
Security > **Microphone** > **Relay Buddy** (or answer the prompt the first time you hold the key).

## Tests and proof

```sh
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
- Do it: "bevel it for me" beveled the cube (Edit Mode, select all, `mesh.bevel`); pressing Undo
  restored the original 8-vertex cube in Object Mode.
- Lesson: three steps planned exactly as listed, each detected done within about 1 s and
  advanced; ended with "Nice, you did it".
- Voice: `RelayBuddy --voice-test` on a spoken file transcribed "Where is the bevel tool?" in
  1.5 s.

## Layout

- `Sources/main.swift`: CLI flags, app start.
- `Sources/AppDelegate.swift`: menu bar, hotkey and voice, target choice, ask, chore and do-it flow.
- `Sources/PromptBubble.swift`: the question bubble.
- `Sources/Capture.swift`, `Sources/CuaDriver.swift`: screenshot, AX tree, cua-driver calls.
- `Sources/Brain.swift`: Responses API calls, tool schemas, lesson planning.
- `Sources/Hooks.swift`: `AppHook`, `BlenderLink`, `BlenderHook`.
- `Sources/Actions.swift`: `do()` actions, the do-it permission check, the executor and undo.
- `Sources/Lesson.swift`: lessons.
- `Sources/Overlay.swift`, `Sources/OverlayExtras.swift`, `Sources/BuddyCharacter.swift`:
  overlay, Buddy, rings, click trail, step pill, Undo pill.
- `Sources/Voice/`: voice input and output.

## Next

- **Relay memory**: send each question, app, answer and lesson progress to Relay Host so Buddy
  remembers what the user already learned and adapts its hints.
- **Blender layout from the add-on**: region and toolbar rects from `bpy` so Buddy aims at
  icons without relying on vision alone.
- **Chores inside lessons**: lessons drop `do()` today; allow chores there with the same Undo.
- **Generic undo**: Cmd+Z is a guess for apps without a hook; record and reverse cua-driver
  actions (close the menu it opened, restore the tab it switched).
