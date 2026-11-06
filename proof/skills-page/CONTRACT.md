# Skills page: shared contract (host <-> desktop)

Worktree: /Users/ike/Eva/work/relay-skills-page (branch eva/skills-page). Deps are ALREADY installed:
apps/linux (root pnpm 9 workspace) and apps/desktop (own pnpm 12 workspace, `corepack pnpm`). Do not add
other deps without saying why. Tiptap is pinned to exactly 3.32.2 on both sides, @tiptap/y-tiptap 3.0.12.

## 1. The document schema (MUST be identical on host and renderer)

Host (headless) and renderer build the ProseMirror schema from the same extension list, else y-tiptap
sync silently drops nodes. Both sides use exactly:

```ts
import StarterKit from '@tiptap/starter-kit'
import Code from '@tiptap/extension-code'
import { TableKit } from '@tiptap/extension-table'
import { TaskList, TaskItem } from '@tiptap/extension-list'

StarterKit.configure({ undoRedo: false, trailingNode: false, underline: false, code: false })
Code.extend({ excludes: '' })           // `**`code`**` is common in Isaac's skills
TableKit                                  // GFM tables
TaskList, TaskItem.configure({ nested: true })
RawMarkdown                               // see below
```

`RawMarkdown` is a custom block node for markdown the editor cannot represent faithfully (HTML blocks,
link definitions, blocks whose parse is not stable). It keeps the exact source; the user edits it as
plain monospace text:

```ts
Node.create({
  name: 'rawMarkdown', group: 'block', content: 'text*', marks: '', code: true, defining: true,
  parseHTML: () => [{ tag: 'pre[data-raw-markdown]', preserveWhitespace: 'full' }],
  renderHTML: () => ['pre', { 'data-raw-markdown': '' }, ['code', 0]],
  // host only: markdown hooks (renderMarkdown returns the text verbatim)
})
```

Renderer adds on top (non-schema): Collaboration ({ document: ydoc, field: 'body' }),
CollaborationCaret ({ provider, user: { name, color } }), Placeholder. Host never adds Collaboration.
Each side has a unit test asserting its schema's node and mark names equal this list:
nodes `blockquote bulletList codeBlock doc hardBreak heading horizontalRule listItem orderedList paragraph rawMarkdown table tableCell tableHeader tableRow taskItem taskList text`,
marks `bold code italic link strike` (verify the exact list once with getSchema and pin it in both tests).

## 2. The live Y.Doc (one per skill being edited, held by the host)

- `body`: Y.XmlFragment, the ProseMirror doc (y-tiptap layout; the editor's Collaboration field `body`).
- `front`: Y.Map `{ name: string, description: string }`: the frontmatter header, editable in the UI
  (renderer writes plain strings; last writer wins).
- `state`: Y.Map, written ONLY by the host: `{ dirty: boolean, diskChanged: boolean, savedAt: number|null, error: string|null }`.
  `dirty` = the doc serialized (pending suggestions rejected) differs from SKILL.md as last loaded/saved. `diskChanged` = SKILL.md changed
  on disk while there were unsaved edits (banner: Reload from disk / Keep mine, save overwrites).
- `threads`, `suggestions`: comment threads anchored to text and agents' pending changes
  (`@relay/canvas-live/doc-threads`). Threads persist to `<relay config>/skill-threads/<encoded name>.json`
  `{ threads: [{ id, quote, resolved, assignee?, messages }] }` and find their text again by `quote`;
  suggestions never reach SKILL.md: save, `dirty` and that file see the doc with every pending
  suggestion rejected, and a reload drops them. A human's new message in a thread (from an editor)
  goes to the assistant it @mentions, else the thread's assignee, else Nova, as a turn in that
  assistant's thread (like a Catch Up handoff) telling it to answer with `skills reply` and to
  suggest changes with `skills edit --thread`; a failed delivery is a Relay line in the thread.

Awareness (y-protocols, y-websocket wire protocol, same as canvas): every participant's state is
`{ user: { name: string, color: string, kind: 'human'|'agent', avatar?: '/canvas/avatar/<id>' }, cursor: { anchor: RelPosJSON, head: RelPosJSON } | null }`
(the fields CollaborationCaret/y-tiptap's cursor plugin read). An agent's cursor is
`Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(xmlText, offset))`.

## 3. Host HTTP (apps/linux, loopback only, JSON; same rules as boards/http.ts: refuse non-loopback,
## refuse an Origin header on writes, writes need content-type application/json)

Names are the skill's name as omp lists it (`canvas`), `^[a-z0-9][a-z0-9._:-]{0,79}(/[a-z0-9][a-z0-9._:-]{0,79})?$`: `:` for plugin-namespaced names, `/` for omp's alias of a copy whose name another source took (`agents/hallmark`, URL-encoded in routes).

- `GET /skills` -> `SkillList`
- `GET /skills/<name>` -> `SkillDetail` | 404
- `POST /skills/<name>/access` `{ enabled: Record<assistantId, boolean> }` -> `SkillRow`
- `POST /skills/<name>/open` `{ user?: { name, color } }` -> `{ token: string, path: '/skills/<name>' }`
  (loads/creates the room; token valid 12 h for that room's websocket)
- `WS /skills/<name>/ws?token=` y-websocket protocol, served by reusing `CanvasSync` (apps/linux/src/canvas/room.ts)
- `POST /skills/<name>/save` `{ force?: boolean }` -> `{ saved: true, savedAt }` | 409 `{ error: 'changed-on-disk' }`
- `POST /skills/<name>/reload` `{}` -> `{ reloaded: true }` (doc replaced from disk, flags cleared)
- `POST /skills/<name>/edit` `{ as: string, color?: string, thread?: string, find?+replace? | after?+insert? | markdown?, save?: boolean }`
  -> `{ ok: true, dirty: boolean, saved: boolean, suggestion?: string }`. Agent edit through the live doc so its named cursor
  shows typing. `after` (text as shown, unique) + `insert` (markdown blocks) adds blocks after that text's block, as items of its
  list when they are one list of that kind. With `thread` the edit is that thread's suggestion `s-<thread>` (Accept / Reject in
  the editor) instead of a change; `markdown` with `thread` is 400, an unknown thread 404.
- `POST /skills/<name>/reply` `{ as: string, color?: string, thread: string, text: string, resolve?: boolean }` -> `{ ok: true }`:
  an agent's message in a comment thread, with its registry look (title, accent, avatar).
- `POST /skills/<name>/leave` `{ as: string }` -> `{ ok: true }`

```ts
interface SkillSource { key: string /* omp's source id: native:project, native:user, agents:user, claude:project, claude-plugins:user, ... */; label: string /* Project, User, Agents, Claude project, ... */; dir: string /* display path, ~ for home */; file: string /* absolute SKILL.md path */ }
interface Assistant { id: string; title: string; profile: string | null; color: string /* avatar.colors.accent */ }
interface SkillRow {
  name: string; description: string
  source: SkillSource            // the copy omp lists (`omp [--profile p] skill list --json` in the Eva checkout; assistants' profiles first)
  also: SkillSource[]            // other copies of the same name other profiles list
  updatedAt: number              // ms, newest mtime in the skill folder
  usedBy: string[]               // assistant ids whose profile lists it and does not disable it, not `enabled: false`
  disabled: boolean              // SKILL.md frontmatter `enabled: false`
  lastUsedAt: number | null      // newest load ever (apps/linux/src/skills/usage.ts)
  uses: number | null            // loads ever; null while the host's first usage scan runs (absent from older hosts)
}
interface SkillList { skills: SkillRow[]; assistants: Assistant[] }
interface SkillAgentUses {
  agent: string                  // assistant id, omp agent (scout, helper-deep, session = default agent), job name, eren, elysia, claude-code, other
  kind: 'assistant' | 'session' | 'subagent' | 'job' | 'background' | 'claude' | 'other'
  owner: string | null           // the assistant it worked for
  uses: number; lastUsedAt: number
}
interface SkillDetail extends SkillRow {
  files: { path: string /* relative to the skill folder */; size: number }[]
  stats: { uses: number; uses7d: number; uses30d: number; lastUsedAt: number | null; firstUsedAt: number | null
           byAgent: SkillAgentUses[] /* most uses first */; daily: number[] /* 30 local days, today last */ } | null
  profiles: Record<string /*assistantId*/, string | null> // profile each assistant runs, so the UI can say toggles are shared
}
```

Per-assistant enable maps to omp's own per-profile mechanism: `disabledExtensions: [skill:<name>]` in
`~/.omp/profiles/<profile>/agent/config.yml`, written with `omp --profile <p> config set disabledExtensions '<json>'`
(injected runner in tests). Nova and Polaris share the `personal` profile, so their toggles move together.

## 4. Desktop IPC (packages/contract/src/skills.ts)

- `skills.list` `{}` -> `SkillList & { available: boolean, error?: string }` (available false when no local host)
- `skills.detail` `{ name }` -> `SkillDetail`
- `skills.access` `{ name, enabled }` -> `SkillRow`
- `skills.open` `{ name }` -> `{ serverUrl: 'ws://127.0.0.1:<port>/skills/<name>', room: 'ws', token, user: { name: 'Isaac', color, kind: 'human' } }`
  (renderer: `new WebsocketProvider(serverUrl, room, ydoc, { params: { token } })`)
- `skills.save` `{ name, force? }` -> `{ status: 'saved' | 'changed-on-disk' }`
- `skills.reload` `{ name }` -> `{ reloaded: true }`

Main calls the host's loopback HTTP via the RelayClient origin (like `main/relay/canvas-live-agent.ts`).
The renderer CSP (`apps/desktop/src/renderer/index.html`) gains `ws://127.0.0.1:*` in connect-src.

## 5. CLI (apps/linux/src/main.ts, `relay-linux skills ...`, posts to hostUrl())

- `skills list [--json]`
- `skills show <name> [--json]`
- `skills edit <name> --as <Name> [--color <hex>] [--thread <id>] (--find <text> --replace <text> | --after <text> (--insert <md> | --stdin) | --file <markdown file> | --stdin) [--save]`
- `skills reply <name> <thread> --as <Name> [--resolve] (<text> | -)`
- `skills save <name> [--force]`
- `skills leave <name> --as <Name>`
