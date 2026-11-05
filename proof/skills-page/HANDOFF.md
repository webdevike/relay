# Skills page: handoff

Branch `eva/skills-page` (worktree `~/Eva/work/relay-skills-page`, off origin/main ae024fd9). Board: `skills-library-page` (layout A, rendered-markdown editor, live agent cursor). Shared contract: `proof/skills-page/CONTRACT.md`.

## What it is
- **Desktop page** `skills` (sidebar Main, under Chat, count badge; deep link `relay://open/skills?skill=<name>`): searchable, sortable table (Name, Description, Source, Used by, Updated) with Source and Used by filters, and a resizable, closable right panel with tabs **Editor** (default) and **Settings**.
- **Editor**: SKILL.md rendered and edited in place with Tiptap (ProseMirror) through `@mantine/tiptap`'s `RichTextEditor`; no top toolbar, no raw markdown, no mode toggle. Floating toolbar on selection (`BubbleMenu`): Text/H1/H2/H3, bold, italic, strikethrough, code, link, bullet list, ordered list, quote. Frontmatter name and description as a compact editable header. `Unsaved` badge and save button appear only when the host marks the doc dirty; Cmd+S saves. A changed-on-disk alert offers Reload or Overwrite.
- **Live cursors**: one Y.Doc per open skill, held by the Relay host and synced over the same y-websocket wire protocol as live canvas (host reuses `CanvasSync` from `apps/linux/src/canvas/room.ts`; the renderer uses stock `y-websocket` + Tiptap Collaboration + CollaborationCaret). Agents edit through the host and show as their own named caret (own awareness bridged into the room, like canvas participants). No "is editing" chip.
- **Settings**: per-assistant switches, scope (Global / One assistant only), source path, files with sizes, last used (time, who, loads in 30 days), Disable skill / Enable skill.
- **Style**: built from Relay's own pieces (shared list kit as in Jobs/Test Bench, Settings cards and rows, stock Mantine tabs, alerts, badges, `AgentPortrait`). The mockups were used for layout and behaviour only; `skills.css` is layout under `.eva-skills` with tokens only, no new global styles, colours, fonts or radii. One type-only change in a shared file: `ui/list/list-context.ts` `ListColumn.label` is `ReactNode` (clickable sort headers).

## How agents edit (once the host is installed)
```
relay-linux skills list [--json]
relay-linux skills show <name> [--json]
relay-linux skills edit <name> --as Nova (--find "<text as shown>" --replace "<text>" | --file new.md | --stdin) [--save]
relay-linux skills save <name> [--force]
relay-linux skills leave <name> --as Nova
```
`--find` selects the unique text inside one block, then types the replacement (caret visible); `--file/--stdin` takes a whole SKILL.md or body and only changed blocks move.

## Markdown fidelity
- `@tiptap/markdown` (MarkdownManager) parses and serializes on the host, per top-level block. Unedited blocks are written back from their original source, so an unedited doc is byte-identical: 86/86 real skills (Eva, ~/.agents, ~/.omp/agent, ~/.claude) round-trip exactly.
- A block the editor cannot represent faithfully (HTML blocks, link definitions, tag-only lines like `</quick_start>`, unstable parses) is kept as a `rawMarkdown` block, edited as plain monospace text: 29 of 2810 real blocks (1%).
- An edited block is re-serialized: its hard-wrapped lines become one line; `<`, `&`, `>` stay literal (models read SKILL.md as source). Cross-check: the real renderer editor mounted on host-seeded docs writes nothing on mount, and an edit to one paragraph changes only that paragraph in the saved file (7 real skills).

## Per-assistant enable
Mapped to omp's own mechanism: `disabledExtensions: [skill:<name>]` in `~/.omp/profiles/<profile>/agent/config.yml`, written with `omp --profile <p> config set disabledExtensions <json>`. Astra is `work`; Nova and Polaris share `personal`, so their switches move together (the panel says so). If `~/.omp/agent/config.yml` ever sets `disabledExtensions`, it overrides every profile (it is passed as a `--config` overlay to profiled sessions), so the host refuses with 409 instead of guessing. Disable skill = off for every assistant; files stay on disk. `enabled: false` in frontmatter shows as disabled.
Used by = assistants whose profile does not disable the skill. Last used = `skill://<name>` reads in omp session logs of the last 30 days (background index, ~2.4 s first scan, ~40 ms cached).

## Libraries
@tiptap/core, react, starter-kit, extension-code, extension-table, extension-list, extension-link, extensions, extension-collaboration, extension-collaboration-caret, markdown (all 3.32.2), @tiptap/y-tiptap 3.0.12, @mantine/tiptap 9.7.2, yjs 13.6.33, y-protocols 1.0.7, y-websocket 3.1.0 (desktop); the same tiptap set plus `yaml` on the host. Desktop now has its own yjs, so `electron.vite.config.ts` and `vitest.config.mts` dedupe yjs/y-protocols/lib0 (else `@relay/canvas-live` pulled the root copy and broke `src/main/canvas/store.test.ts`).

## Verification (freeze: no e2e, Electron launch, deploy or host install)
- apps/linux: `VITEST_MAX_WORKERS=2 pnpm vitest run` 624/624 tests (only `canvas-pacing.test.ts` fails to load: it imports `bun:test`, same on origin/main); `pnpm typecheck` clean; eslint clean on the new and touched files (pre-existing errors elsewhere).
- apps/desktop: `corepack pnpm typecheck` clean; full vitest green (2 workers); prettier, em-dash and spacing lints clean; eslint clean on touched files (full `pnpm lint` stops on pre-existing errors in the gitignored `resources/RelayHost/.../omp-extension`).
- Not seen on screen: no screenshots were possible under the freeze.

## Left / next
1. After the freeze: **host install** (new `/skills` routes, websocket, CLI) and **desktop deploy** (page, editor, CSP `ws://127.0.0.1:*`). Both are needed: the page shows "Skills needs the Relay host running on this Mac." against today's host, and `relay-linux skills list` answers `not found`.
2. Then a visual and e2e pass: proof screenshots (Editor with an agent caret via `skills edit --as Nova`, Settings), and an e2e spec for open, edit, save, changed-on-disk.
3. Desktop only: remote hosts are not supported (loopback routes); no mobile (file editing is a desktop concept).
4. Teach agents: add the `relay-linux skills edit` commands to the relay-control skill once the host ships.
