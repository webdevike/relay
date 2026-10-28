# @evaos/desktop (Relay)

The Electron app: `src/main` (main process), `src/preload` (the `window.eva` bridge, generic over
the channel lists in `@evaos/contract`), `src/renderer` (React + Mantine). Every IPC channel is a
zod schema in `packages/contract`; main validates inputs, the renderer calls
`invoke(channel, input)` and subscribes with `on(channel, cb)`.

```
pnpm dev        # Relay Dev: fixtures and fake omp (safe), temp config dir
pnpm dev:live   # Relay Dev with real ~/Eva and real omp; CDP 9340, agent control on
pnpm typecheck
pnpm exec vitest run --project main|preload|renderer
```

How to install a packaged copy is in `TRY.md` at the repo root.

## Stable app and Relay Dev

Exactly one copy is the **stable** app Isaac uses: `EVAOS_STABLE=1` (or a packaged build), run by
a supervisor from the separate stable checkout `work/evaos-electron-live`. Every other copy
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

An agent's portrait moves with its thread through `@relay/portrait-motion` (linked from the Relay
checkout like `@relay/widget-runtime`; its DiceBear styles are deduped with ours in
`electron.vite.config.ts`). `renderer/assistants/motion-signals.ts` derives the engine's signals
per agent: Relay's status (`working` runs, `needs-you` waits; main reads omp's open `ask` as
`needs-you`), Start on its way (runs) or refused (fails), the last reply's time, and, only while
main's chat pane shows the agent's thread file, its stream (Talking, ChatLog's rule), running tool
rows, subagents and jobs (Working), question card (Confused) and error banner or `Error:` notice
(Error). No call reaches the desktop, so Listening never shows. The engine's `Director` turns
those into Hello, Idle, Thinking, Working, Talking, Done, Confused, Error, Snoozing and Waking.

- **Small portraits** (tab, crumb, Assistants home and sidebar rows: `PortraitMotion`) share one
  director per agent (`motion-store.ts`, ticked on store changes and once a second) and animate in
  CSS only: breathing, the turning accent ring while thinking or working, and a dot in the state's
  tone (accent, orange needs you, red failed).
- **The start card** (`PortraitCard`, 84 px) draws every engine frame as inline SVG at most 24
  fps (`portrait-painter.ts`), greeting with Hello each time the page opens.
- Motion off (`html[data-eva-motion='off']`: e2e, `EVAOS_NO_MOTION`, or the system's reduced
  motion) holds every portrait still, the ring included; a hidden page runs no frames and pauses
  the CSS (`motion-gate.ts`). `e2e/assistant-motion.spec.ts` drives a thread through every state;
  `EVAOS_MOTION_PROOF=<dir>` turns motion on and records it plus CPU samples.

## Right panel

The panel card holds two tools, picked by the Browser / Files tabs in its header, plus transient
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

Not included on purpose: extensions, debugger, terminal, settings UI, file create/rename/delete,
replace across files, a language server.

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

Eva's client is `bun .omp/tools/relay-ctl.ts` in the Eva repo (`skill://relay-control`).
