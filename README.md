# Relay Buddy (Phase 1 prototype)

A macOS menu-bar helper for learning apps. Press **Control+Option+Space**, ask where something is,
and Buddy (a small blue cursor with a face and a "Buddy" name tag) glides to the control, pulses a
ring on it, shows a one-line caption, then fades about 2 seconds later. Text only for now; voice
comes in Phase 2.

Proof: `proof/relay-buddy-phase1.mp4` (full run against Blender), `proof/bevel-closeup.mp4`,
`proof/contact-sheet.jpg` (frames from the run), plus single-question clips for Blender in Object
Mode, Blender in Edit Mode and System Settings.

## Build and run

```sh
./build.sh                       # swiftc build into build/RelayBuddy.app, signed with the local
                                 # Apple Development identity when present (stable privacy grants)
open build/RelayBuddy.app        # menu-bar app, no Dock icon
```

The OpenAI key comes from `OPENAI_API_KEY`, else `/Users/ike/Eva/secrets/openai.env`
(override the path with `RELAY_BUDDY_ENV_FILE`). Model: `gpt-6.1-terra` (`RELAY_BUDDY_MODEL`),
reasoning effort `low` (`RELAY_BUDDY_EFFORT`).

Scripted use, for tests and for other apps such as Relay:

```sh
B=build/RelayBuddy.app/Contents/MacOS/RelayBuddy
$B --send "where is the bevel tool?" --target Blender   # ask the running Buddy
$B --send "where is loop cut? stay"                     # "stay" keeps Buddy up until Esc or a click
$B --summon                                             # same as the hotkey (toggles the bubble)
$B --ask "question" [--target app]                      # start Buddy and ask once it is up
```

`--target` takes an app name or bundle id; without it Buddy looks at the frontmost app. A newly
started Buddy tells any older instance to quit, so rebuild and run never leaves two.

## How it behaves

- **Hotkey**: Carbon `RegisterEventHotKey`, so it needs no permission and swallows only that combo.
- **Prompt bubble**: a non-activating panel at the cursor. The app you are learning stays
  frontmost. Drag it anywhere; Esc, the close button or a click elsewhere closes it. While you
  type, Buddy already captures the window, so the wait after Return is just the model call.
- **What Buddy sees**: the frontmost window of the target app only (ScreenCaptureKit window
  capture at up to 3840 px on the long edge) plus a trimmed accessibility tree: labelled or
  interactive elements with frames, at most 220 lines in 1 s, plus the app's menu bar.
- **Model call**: OpenAI Responses API with four strict function tools, `say(text)`,
  `point(x, y, label)`, `highlight(rect, label)` and `done()`, all requested in one parallel turn
  (one follow-up turn if the model stops before pointing). Coordinates are screenshot pixels.
  The last screenshot, prompt and response land in `~/Library/Caches/RelayBuddy/last/`.
- **Buddy overlay**: a transparent, click-through window on every Space, never key, never main.
  Buddy thinks at your cursor ("Looking at Blender..."), glides along a slight curve, squashes on
  arrival, pulses a ring (or outlines a rect), and fades after 2 s plus up to 1 s for long captions.
  Any click (it still reaches the app) or Esc dismisses it at once. A question containing "stay"
  keeps Buddy up, and its tag reads "Buddy · staying".
- **Log**: `~/Library/Logs/RelayBuddy.log` (timings and the tool calls).

## Permissions

| Feature | Needs |
| --- | --- |
| Hotkey, bubble, overlay, click-to-dismiss | nothing |
| Screenshot of the window | Screen Recording, or the running cua-driver daemon |
| Accessibility tree, Esc-to-dismiss while another app is frontmost | Accessibility, or cua-driver for the tree |

Buddy never asks for permissions on its own. It picks a capture path at launch:

1. **Native** (ScreenCaptureKit + AX in process) when the process holds Screen Recording. A
   process started from a terminal that holds the grants inherits them; that is how the tests ran.
2. **cua-driver** otherwise: it calls `cua-driver call get_window_state` against the already
   authorized CuaDriver daemon (`com.trycua.driver`). Launched with `open`, Buddy works this way
   with no grants of its own. Start the daemon with `open -n -g -a CuaDriver --args serve`.

To give Buddy its own grants, choose **Give Buddy Its Own Permissions…** in its menu-bar menu, then
in System Settings > Privacy & Security turn on **Relay Buddy** under **Screen & System Audio
Recording** and under **Accessibility**, and relaunch Buddy.

## Tests and proof

```sh
tools/prooftest.sh "where is the bevel tool?" Blender proof/blender-bevel.mov 16
tools/record-proof.sh proof/relay-buddy-phase1.mov
RELAY_BUDDY_CAPTURE=cua-driver tools/prooftest.sh "where is the bevel tool?" Blender build/cua.mov 12
```

`tools/proofrec.swift` records the main display with ScreenCaptureKit, keeping only the windows of
the given processes (target app + Buddy). It works while the Mac is locked, where
`screencapture -v` only records the lock screen.

Results on 2026-11-02 (Mac locked, Blender 5.2.2):

- Blender, Edit Mode, "where is the bevel tool?": points at the Bevel icon in the left toolbar,
  "Click Bevel here, or press Ctrl+B with edges selected." About 3.8 s from ask to pointing
  (1.0 s capture, 2.7 s model).
- Blender, Object Mode: points at the mode dropdown, "Switch to Edit Mode (Tab), select edges,
  then press Ctrl+B to bevel."
- Blender, Edit Mode, "where is the loop cut tool? stay": points at Loop Cut and stays until the
  next summon dismisses it.
- System Settings, "where do I change the wallpaper?": points at Wallpaper in the sidebar.
- Launched with `open` (no grants of its own): the cua-driver path captured in 0.5 s and pointed
  at the mode dropdown.

## Layout

- `Sources/main.swift`: CLI flags, app start.
- `Sources/AppDelegate.swift`: menu-bar item, hotkey, bubble to capture to model to overlay flow.
- `Sources/HotKey.swift`: Carbon hotkey.
- `Sources/PromptBubble.swift`: the question bubble.
- `Sources/Capture.swift`: window lookup, ScreenCaptureKit screenshot, AX tree.
- `Sources/CuaDriverCapture.swift`: capture through cua-driver.
- `Sources/Brain.swift`: Responses API call, tool schema, parsing.
- `Sources/Overlay.swift`, `Sources/BuddyCharacter.swift`: overlay window, Buddy, rings, fades.

## Phase 2

- **Voice**: GPT realtime for hold-to-talk in the bubble and spoken answers; keep the caption.
- **Blender MCP hook**: Blender draws its own UI, so the AX tree is empty there and Buddy relies on
  vision. The Blender MCP (`execute_blender_code`) can report the mode, active tool, selection
  and exact region and toolbar rects, so Buddy can aim without guessing.
- **Do-it mode**: chores such as switching mode or opening a menu, announced in the caption with
  an undo. The Blender MCP and cua-driver `invoke_menu`/`click` are the natural actuators.
- **Relay memory**: send each question, app and answer to Relay Host so Buddy remembers what the
  user already learned and adapts its hints.
