# @evaos/desktop (Relay)

The Electron app: `src/main` (main process), `src/preload` (the `window.eva` bridge, generic over
the channel lists in `@evaos/contract`), `src/renderer` (React + Mantine). Every IPC channel is a
zod schema in `packages/contract`; main validates inputs, the renderer calls
`invoke(channel, input)` and subscribes with `on(channel, cb)`.

Its own pnpm workspace inside the Relay monorepo (`pnpm-workspace.yaml` here: this app and
`packages/{browser-core,chat-core,contract,eva-core,shell-core}`, pnpm 12, isolated linker), kept
out of the root's hoisted install where the phone app's React 19.1 lives. It links
`@relay/{portrait-motion,slack-emoji,widget-runtime}` from `packages/`, so install all three:

```
pnpm install                                                     # repo root (Relay packages)
(cd packages/widget-runtime && pnpm install --ignore-workspace)  # repo root
cd apps/desktop && pnpm install && (cd node_modules/electron && node install.js)
```

```
pnpm dev        # Relay Dev: fixtures and fake omp (safe), temp config dir
pnpm dev:live   # Relay Dev with real ~/Eva and real omp; CDP 9340, agent control on
pnpm typecheck
pnpm exec vitest run --project main|preload|renderer|scripts
pnpm lint       # eslint, prettier, em-dash and spacing lints, run from the repo root
```

`pnpm dev`, `pnpm dev:live`, `pnpm e2e` and `pnpm gate` also work from the repo root. How to
install a packaged copy is in `TRY.md` next to this file.

## Stable app and Relay Dev

Exactly one copy per Mac is the **stable** app Isaac uses: the packaged `/Applications/Relay.app`
(or `EVAOS_STABLE=1`), built, signed and published by `.omp/tools/relay-desktop-deploy.ts` from
the separate stable checkout `work/relay-monorepo-live`; it updates itself
(`src/main/update/packaged.ts`) and starts Relay Assist as its child (`src/main/assist.ts`). Every other copy
(agent testing, `pnpm dev`, `pnpm dev:live`, e2e) is **Relay Dev**: app name and window title
`Relay Dev`, a `DEV` pill in the footer (hover shows its config dir), its own config dir and CDP
port. `src/main/env.ts` refuses to start Relay Dev on the stable config dir or port.

|                  | stable                                        | Relay Dev (`EVAOS_LIVE=1`)                | Relay Dev (default)                |
| ---------------- | --------------------------------------------- | ----------------------------------------- | ---------------------------------- |
| config dir       | `~/Library/Application Support/Relay Desktop` | `~/Library/Application Support/Relay Dev` | `$TMPDIR/evaos-electron-dev-<pid>` |
| CDP port         | 9339                                          | 9340                                      | off                                |
| Relay phone link | `~/.config/relay`                             | only with `EVAOS_RELAY_DIR`               | off                                |
| footer           | `stable · <EVAOS_BUILD>`                      | `DEV` pill                                | `DEV` pill                         |

Agents test only in Relay Dev (`EVAOS_CONFIG_DIR` in `/tmp`, a CDP port other than 9339,
`EVAOS_HIDDEN_WINDOW=1`), never against the stable app or port 9339. Hidden instances print
fatal errors to stderr instead of opening a dialog.

The stable app is updated only by `bun .omp/tools/relay-desktop-deploy.ts` (Eva repo). The deploy
builds the stable checkout and runs the agent action `update.offer {summary, build}`; the app
shows a persistent "Update ready" toast (Restart now / Later; after Later a footer chip offers the
restart). Restart runs the normal quit path (unsaved edits still ask) and exits with code **75**,
which is the only exit the supervisor relaunches. Restarts happen when Isaac clicks Restart now
(or the chip), or on their own after 2 minutes without keyboard or mouse input while no chat the
app runs is mid-reply (checked every 15 s, `src/main/update/policy.ts`); while he is active the
toast just stays. Nothing is lost: tabs, the side panel, page tabs, window bounds and composer
drafts come back. Drafts (unsent text, not attached images) are saved per chat in `drafts.json`
in the config dir, keyed by session file or, for a new chat, its tab's `draft:<tab id>` scope
(tab ids persist in `layout.json`); a sent message clears its draft. `EVAOS_SHOW_INACTIVE=1` (set
by the supervisor) shows the relaunched window without taking focus. `state.read` reports
`instance`, `build`, `update {pending, build, summary}` and the open chat's `draft`.

## Assistant portraits

An agent's portrait moves calmly with its thread through `@relay/portrait-motion` (linked from the
Relay checkout like `@relay/widget-runtime`; its DiceBear styles are deduped with ours in
`electron.vite.config.ts`). `renderer/assistants/motion-signals.ts` derives the engine's signals
per agent: `running` from Relay's status (`working`), Start on its way, or the open pane running
(a streaming reply is just running); `tool` from what its running tools do (`toolKind`): running
subagents first (`Subagent.tool`, the call main sees still open in each transcript), else the
tool Relay hears (`Assistant.tool`, Relay's status detail while working), else the open pane's
running tool row, else background jobs (work); `waiting` from `needs-you` (main reads omp's open
`ask` that way) or the pane's question card; `failed` from a refused Start, the pane's error
banner or an `Error:` notice in the last turn; `activityAt` from the last reply. The engine's
`Director` turns those into one of five faces: Thinking, Researching (search, fetch, reads),
Working (anything else), Idle, Snoozing after 30 quiet minutes (Waking when it stirs). The face
alone shows state on an avatar: no working ring, no status dot. Needing Isaac and failing never
change the face; the agent's crumb says them.

- **Small portraits** (tab, crumb, Assistants home and sidebar rows: `PortraitMotion`) share one
  director per agent (`motion-store.ts`, ticked on store changes and once a second) and only
  breathe, in CSS (slower while snoozing).
- **The crumb** ("< Assistants / Nova") follows the name with muted words (`CrumbStatus`, the
  package's `statusText`): "is thinking", "is researching", "is working", "is
  away", "needs you" while it waits, "hit a snag" after a failure, nothing at rest. A change
  crossfades in 180 ms in one grid cell (no layout jump), at once with motion off; long words end
  in an ellipsis.
- **The start card** (`PortraitCard`, 84 px) draws every engine frame as inline SVG at most 24
  fps (`portrait-painter.ts`) in the engine's Extended mode (one `extension()` per card): brows
  turn and the head turns (matrices), the mouth morphs between shapes (a layer's `morph` paths drawn
  instead of its part) and eyelids close (the eyes clipped to the layer's `clip` rects through a
  per-card `clipPath`, the lids' edges drawn over them). It also draws the engine's overlays
  (Researching's magnifier, z z z) but not its dot ring (`fx.dots`). Markup changes only when a
  frame's part, morph, clip or lids do.
- Motion off (`html[data-eva-motion='off']`: e2e, `EVAOS_NO_MOTION`, or the system's reduced
  motion) holds every portrait still (the card's plain resting face); a hidden page or window
  (main's `app.windowShown`) runs no frames and pauses the CSS (`motion-gate.ts`).
  `e2e/assistant-motion.spec.ts` drives a thread through every face and crumb word;
  `EVAOS_MOTION_PROOF=<dir>` runs only its proof instead: motion on, Nova's and Astra's cards
  through Idle, Thinking, Researching, Working (with screenshots) and Snoozing (laid over their
  signals with the e2e hook `__evaosShell.portraitSignals`, since a start card has no quiet
  thread), recorded, plus CPU samples.

## Desktop notifications

`main/notifications/` (policy.ts when, events.ts what, notifier.ts ties them to the app). Events:
an assistant's new reply (held until its thread stops working, so a turn is one notification;
`(nothing to report)` is none), a chat or Working-list item that starts waiting on Isaac (approval,
question, permission), a live canvas room (the Join card), a quiet "Finished" for a chat that is
not an assistant thread, and "Relay update ready", once per build (`notifications-state.json`).
Replies, waiting items and rooms come through Relay, so a thin client (the MacBook) notifies from
the Mini host's events like the Mini does. Rules, in order:

- Settings > Notifications: a global switch and one switch per assistant (a mute silences its
  replies, questions and canvases), saved per Mac in `notifications.json`.
- Only while Isaac is at this Mac: input in the last 10 minutes (`powerMonitor.getSystemIdleTime`).
  Otherwise the phone's push is the notification. An update is exempt (only this app knows it).
- A focused window stays quiet for the chats in front (the window reports them as
  `notifications.visible`); another chat, or an unfocused window, still notifies.
- The same thing within a minute is told once; each assistant is one stack in Notification Center
  (`groupId`). A click raises the window and opens the chat (`chat.openRequested`) or a relay://
  link (`app.openLink`).
- Fixture runs never notify unless `EVAOS_NOTIFY_REAL=1`; e2e records them instead
  (`__evaosTest.hooks.notifications`).
- macOS only shows a notification for a signed bundle with its own id (`dev.eva.relay-desktop`);
  a dev Electron run is dropped by the system.

## Right panel

The panel card holds tools, picked by the Browser / Files / Terminal tabs in its header, plus transient
views over them (a subagent's transcript, an experiment arm). The last tool picked survives chat
switches; a new browser tab brings the browser back (`shell/layout-store.ts`).

## Files

A slim editor over one folder: the open chat's active worktree, else its cwd, else the Eva root
(`files.root`). Code: `src/main/files/` (fs, git, search, watch) and `src/renderer/files/`.

- **Tree**: lazy folders, Material Icon Theme icons resolved like VS Code (file name, longest
  extension, language id; light variants), git colors and letters (M, A, U, D, R, C; folders show
  a dot for changes below), ignored files hidden with a toggle. Arrow keys, Enter, Space,
  Home/End. The active file is revealed as tabs change.
- **Quick open** (Cmd+P, from anywhere): fzy-ranked file names first, then paths; recent files
  boosted; `path:line[:col]` jumps.
- **Search in files** (Cmd+Shift+F): ripgrep when installed, else `git grep`, else a scan; match
  case, whole word, regex. Capped at 2000 matches.
- **Editor**: Monaco bundled with local workers (no CDN). Tabs with preview (italic) tabs, dirty
  dot, middle-click close, Cmd+W. Multi-cursor (Option+click, Cmd+D, Cmd+Option+Up/Down), find and
  replace (Cmd+F, Cmd+Option+F), minimap off, theme read from the app's Mantine colors in light
  and dark. Markdown has a preview toggle. Images preview; binary and files over 5 MB show a
  notice. Cmd+Shift+E focuses the explorer.
- **Saving**: Cmd+S writes through main with an atomic rename (temp sibling, mode kept), refused
  with `changed-on-disk` when the file moved on since it loaded (the banner offers "Load disk
  version" or "Overwrite"). Dirty tabs join the quit guard.
- **Watching**: main watches the expanded folders and open files; a clean tab reloads, a dirty
  one shows the banner.
- **Safety**: main serves only roots it resolved itself; every path is checked to stay inside the
  root after symlinks; `.git` and `secrets` are locked; saves never create files.

Not included on purpose: extensions, debugger, settings UI, file create/rename/delete,
replace across files, a language server.

## Terminal

A tool tab next to Files: real terminals, xterm.js in the page over node-pty in main
(`terminal.*` channels; code in `src/main/terminal/` and `src/renderer/terminal/`).

- **Shells**: the user's login shell (`$SHELL -l`) in the open chat's active worktree, else its cwd,
  else the Eva root. A tab strip holds several; each keeps its screen and process while the tab
  exists (switching tabs, panes or panels never remounts it), and closing a terminal, or the
  Terminal tab, ends its pty. `exit` closes the terminal's tab. Up to 16 at once; all end on quit.
- **Attach to session**: a chat that runs in herdr (`herdr agent list` reports its session file) gets
  an attach button. It starts `herdr agent attach <pane> --takeover` in a pty, so the tab shows that
  session's live omp/Claude Code/Codex TUI and takes keystrokes. Detach is herdr's `ctrl+b q`, or
  closing the tab; the session itself keeps running in herdr either way. One attach tab per chat.
  Without herdr, or for a chat that is not in herdr, only shells are offered.
- **Environment**: `TERM=xterm-256color`, `COLORTERM=truecolor`; Electron's `ELECTRON_*` and herdr's
  pane markers (`HERDR_ENV`, `HERDR_PANE_ID`, ...) are dropped so a nested `herdr` still starts.
- **Look**: colors come from the panel's Mantine surface and accent, with a fixed ANSI palette per
  scheme; they follow light/dark. Links open through Settings > Links. While a terminal has focus,
  app chords yield to it except the pass-through list (`TERMINAL_PASS_THROUGH`).
- **Safety**: only the app shell page can call `terminal.*`, and it names a chat's session file and
  a mode, never a command or folder; main picks both.

## Agent control

Agents drive the running app through one typed action registry, `agentActions` in
`packages/contract/src/agent.ts`: each entry has a title, a zod params schema, its side (`main` or
`renderer`), what it replaces (`focus`: `main`, `panel` or `none`) and whether it is destructive.
Typecheck fails until the side implements a new entry (`src/main/agent-control/index.ts`,
`src/renderer/agent/actions.ts`), so adding a UI action there makes it agent-callable.

Main serves it over HTTP on 127.0.0.1 (random port; live default on, `EVAOS_AGENT_CONTROL=1|0`
overrides) and writes `{port, token, url, pid}` to `<configDir>/agent-control.json` (0600; removed
on quit). Every request needs a loopback peer, a loopback `Host` and `Authorization: Bearer
<token>`.

- `GET /actions`: the catalog, params as JSON Schema. `POST /actions/:id` with
  `{params, confirm?, scope?}`. `GET /state`, `GET /screenshot` (PNG via `capturePage`, browser view
  composited in).
- **Scope**: panel actions (and `testbench.open` with `arm`) take `scope`, the page or chat whose
  side panel they act on: a page key (`agent:nova`, `test-bench`), a chat session id or file, or a
  browser scope (`page:…`, `chat:…`). The body's `scope` (the caller's own) fills in for panel
  actions whose params name none. A scope not in front gets the change without a page switch
  (browser tabs open in its scope; Files, panel views and arms show when Isaac opens it), never
  queues, and its app tab gets a dot ("Nova opened a tab"; a short toast when no tab shows it).
  Results echo `scope` and `background` (`renderer/agent/scope.ts`).
- **Focus**: nothing calls `show`/`focus` on the window. While Isaac types in a text field an
  action would replace (anywhere for `main` actions, inside the panel for `panel` ones), it queues
  (HTTP 202, a toast with Run now) and runs once the field loses focus or the window blurs. Every
  action runs under a focus hold (`renderer/agent/focus-safety.ts`): the Files editor skips its
  own `focus()`, and a text field that lost focus gets it back.
- **Destructive** (`app.quit`, `chat.start`): 403 `confirm-required` without `confirm: true`;
  with it, an Allow / Deny toast; no answer in 60 s is `denied`.
- **Remote** (`src/main/agent-control/remote.ts`): agents on the Mini reach this app on whichever
  Mac Isaac uses, through the Relay Host. On a host whose `welcome.features` has `control`, the app
  sends `control.presence` (Mac name, instance, ms since Isaac last pressed a key, clicked,
  scrolled or brought the window forward, the page in front, focus, remote mode) on connect and
  after changes (at most once a second; the renderer reports input through `agent.presence`). The
  host's `control.req {rid, action, params?, confirm?, scope?}` runs through the same runner as
  `POST /actions/:id` (registry, params, confirm and Isaac's approval, scope, typing queue) and
  answers `control.res` with the rid; `@actions` answers the catalog. Only the host's
  authenticated connection delivers frames, and no client can send `control.req`, so nothing but
  processes on the host's Mac reaches it. The Undo and approval toasts show here, on the Mac that
  changed.

Eva's client is `bun .omp/tools/relay-ctl.ts` in the Eva repo (`skill://relay-control`).
