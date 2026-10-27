# @evaos/desktop (Relay)

The Electron app: `src/main` (main process), `src/preload` (the `window.eva` bridge, generic over
the channel lists in `@evaos/contract`), `src/renderer` (React + Mantine). Every IPC channel is a
zod schema in `packages/contract`; main validates inputs, the renderer calls
`invoke(channel, input)` and subscribes with `on(channel, cb)`.

```
pnpm dev        # fixtures and fake omp (safe)
pnpm dev:live   # real ~/Eva and real omp; CDP on 9339
pnpm typecheck
pnpm exec vitest run --project main|preload|renderer
```

How to install a packaged copy is in `TRY.md` at the repo root.

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
