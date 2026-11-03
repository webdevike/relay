# Phase 3: Dashboard, Workspaces, Jobs, Habits and Meetings - Pattern Map

**Mapped:** 2026-10-15
**Files analyzed:** 46 new or modified (grouped by layer below)
**Analogs found:** 42 / 46 (4 have no in-repo analog, see end)

Paths are relative to `/Users/ike/Eva/work/evaos-electron`. Rust behavior rules live in 03-RESEARCH.md ("Exact Rules"); this file only says which existing repo code to copy structure from.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/eva-core/src/model/tags.ts`, `plain.ts` | utility | transform | `packages/eva-core/src/sidebar/jobs.ts` (pure helpers) | role-match |
| `packages/eva-core/src/model/journal.ts` | utility (parser) | transform | `packages/eva-core/src/sidebar/journal.ts` | exact (stricter rule) |
| `packages/eva-core/src/model/todos.ts` | utility (parser + pure writer) | transform | `packages/eva-core/src/sidebar/todos.ts` | exact |
| `packages/eva-core/src/model/workspaces.ts`, `dashboard.ts` | service (reader + compute) | file-I/O + transform | `packages/eva-core/src/sidebar/read.ts` | exact |
| `packages/eva-core/src/model/jobs.ts` | utility (parser + line editor) | transform + file-I/O | `packages/eva-core/src/sidebar/jobs.ts` | exact |
| `packages/eva-core/src/model/gate.ts` | model (Zod schema + streak) | transform | `packages/contract/src/eva.ts` (Zod shape) | role-match |
| `packages/eva-core/src/model/meetings.ts` | utility (parser + JSON editor) | file-I/O + transform | `packages/eva-core/src/sidebar/read.ts` | role-match |
| `packages/eva-core/src/clock.ts` | utility | transform | `apps/desktop/src/main/env.ts` (env seam) | partial |
| `packages/eva-core/src/fs/eva-fs.ts` (modify: `edit`, `create`, stamp) | service (writer) | CRUD | itself (`eva-fs.ts`) plus `atomic-write.ts` | exact |
| `packages/eva-core/src/fs/allowlist.ts` (modify NAME_RE) | config | request-response | itself | exact |
| `packages/eva-core/src/**/*.test.ts` (model tests) | test | n/a | `packages/eva-core/src/fs/eva-fs.test.ts`, `sidebar/sidebar.test.ts` | exact |
| `packages/eva-core/src/write-scan.test.ts` (modify) | test | batch | itself | exact |
| `packages/contract/src/eva.ts` (new channels) | contract | request-response | itself (`eva.sidebar`) | exact |
| `apps/desktop/src/main/eva-ipc.ts` (+ `eva/jobs-ipc.ts`, `habit-ipc.ts`, `meetings-ipc.ts`) | controller | request-response | `main/eva-ipc.ts`, `main/chat/live-ipc.ts` | exact |
| `apps/desktop/src/main/eva/spawn.ts` | service | event-driven (process) | `main/chat/omp-transport.ts` + `chat/shell-path.ts` | role-match |
| `apps/desktop/src/main/eva/watch.ts` | service | event-driven | `main/chat/live-ipc.ts` (`emit` pattern) | partial |
| `apps/desktop/src/main/env.ts` (modify: seams) | config | n/a | itself (`ompBin`) | exact |
| `apps/desktop/src/main/test-hooks.ts` use (`spawnLog`) | utility | n/a | `chat/live-ipc.ts` lines 31-49 | exact |
| `apps/desktop/src/renderer/dashboard/dashboard-store.ts`, `jobs/`, `habits/`, `meetings/` stores | store | request-response | `renderer/sidebar/sidebar-store.ts` | exact |
| `apps/desktop/src/renderer/habits/habit-store.ts` (poll, generation) | store | polling | `sidebar-store.ts` + `settings-store.ts` | role-match |
| `renderer/dashboard/DashboardPage.tsx`, `workspace/WorkspacePage.tsx`, `jobs/JobsPage.tsx`, `habits/HabitsPage.tsx`, `meetings/MeetingsHome.tsx`, `MeetingPage.tsx` | component (page) | request-response | `renderer/pages/PlaceholderPage.tsx`, `settings/SettingsPage.tsx` | role-match |
| `renderer/todo/NewTodoModal.tsx`, `jobs/JobForm.tsx` (modal/drawer forms) | component | CRUD | `renderer/overlay/EvaModal.tsx`, `browser/ImportArcModal.tsx` | exact |
| `renderer/habits/GateOverlay.tsx` | component | request-response | `renderer/overlay/overlay-store.ts` (`useOccludeBrowser`) + `EvaModal.tsx` | role-match |
| `renderer/ui/ActivityChart.tsx` | component | transform | none in repo | no analog |
| `renderer/pages/registry.ts`, `PageRouter.tsx`, `page-meta.ts`, `tabs/tab-meta.ts` (modify) | config/route | request-response | themselves | exact |
| `renderer/sidebar/SubPages.tsx` (modify meetings body) | component | request-response | itself | exact |
| `renderer/hotkeys/router.ts` (gate-lock guard, new-todo/reload actions) | middleware | event-driven | itself | exact |
| `renderer/main.tsx` (Notifications position, charts css) | config | n/a | itself | exact |
| `fixtures/eva-p3/**`, `fixtures/fake-gate/fake-gate.mjs`, `fixtures/fake-job-run/fake-job-run.mjs` | fixture/test double | event-driven | `fixtures/fake-omp/fake-omp.mjs`, `fixtures/eva-root/**` | exact |
| `apps/desktop/e2e/{dashboard,workspace,jobs,habits,gate,meetings}.spec.ts`, `helpers/eva-fixture.ts` | test | e2e | `e2e/sidebar.spec.ts`, `e2e/fixtures.ts` | exact |

## Pattern Assignments

### `packages/eva-core/src/model/todos.ts` (utility, transform)

**Analog:** `packages/eva-core/src/sidebar/todos.ts` (lines 1-21). Keep the exact filter predicate so counts agree with the sidebar; extract rows instead of counting.

```typescript
export function countOpenTodos(text: string): number {
  let inOpen = false
  let count = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '## Open') { inOpen = true; continue }
    if (!inOpen) continue
    if (line.startsWith('## ')) break
    if (!line.startsWith('- [ ] ')) continue
    const rest = line.slice('- [ ] '.length)
    const sp = rest.search(/\s/)
    const id = sp < 0 ? rest : rest.slice(0, sp)
    const after = sp < 0 ? '' : rest.slice(sp)
    if (!id.startsWith('T')) continue
    if (/\[[^\]]*\]/.test(after)) count++
  }
  return count
}
```

Pure `appendTodo(todos, done, tag, text, today) -> { id, next }`: copy the code in 03-RESEARCH.md "Code Examples". Errors use `Object.assign(new Error(msg), { code: 'invalid-data' })` so `handle()` maps the kebab code to a result code. Pure string-in, string-out; no `fs` imports in `model/`.

### `packages/eva-core/src/model/journal.ts` (utility, transform)

**Analog:** `packages/eva-core/src/sidebar/journal.ts` (lines 7-17). Do NOT reuse its looser `HEADING` regex for activity (tag optional); `model/journal.ts` needs a mandatory `[tag]`. Copy the file shape: exported interface, one module-level regex, line loop.

```typescript
const HEADING = /^## (\d{4}-\d{2}-\d{2})(?: \[([^\]]+)\])? (.*)$/
export function recentJournal(text: string, cap = 8): RecentEntry[] {
  const all: RecentEntry[] = []
  for (const line of text.split('\n')) {
    const m = HEADING.exec(line.trimEnd())
    if (m) all.push({ date: m[1]!, tag: m[2] ?? null, title: m[3]!.trim() })
  }
  return all.reverse().slice(0, cap)
}
```

Em-dash separators in parsers must be written as the escape `'—'` (lint rule in `scripts/lint-em-dash.ts`).

### `packages/eva-core/src/model/workspaces.ts`, `dashboard.ts` (service, file-I/O)

**Analog:** `packages/eva-core/src/sidebar/read.ts` (lines 1-35): a `readText` that swallows missing files, `readdirSync(withFileTypes)` in try/catch, synchronous `readX(root)` returning a plain data object.

```typescript
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
function readText(path: string): string {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : '' } catch { return '' }
}
export function readSidebar(root: string): SidebarData {
  /* ... */
  try {
    for (const d of readdirSync(join(root, 'jobs'), { withFileTypes: true })) { /* ... */ }
  } catch { /* no jobs dir */ }
}
```

Keep file reads in a thin `readDashboard(root, today)` wrapper and compute in pure functions (`buildDashboard(inputs, today)`) so Vitest runs them without a tree. Export from `packages/eva-core/src/index.ts` next to the existing sidebar exports (line 4-7 style).

### `packages/eva-core/src/model/jobs.ts` (utility, transform + file-I/O)

**Analog:** `packages/eva-core/src/sidebar/jobs.ts` (lines 1-38). Reuse `parseDurationMs` and `cleanValue` (import or move, keep Phase 2 tests green). Differences to implement: last occurrence of a key wins (sidebar version is first-wins, line 26), key regex `^([A-Za-z_][\w-]*):\s*(.*)$`, verbatim frontmatter lines preserved for byte-identical round trip.

```typescript
export function parseDurationMs(text: string): number | null {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return n * mult[m[2] ?? 'm']!
}
```

Name validation regex `^[a-z0-9][a-z0-9-]*$` (discrepancy D2). Keep is a duration (D1).

### `packages/eva-core/src/fs/eva-fs.ts` (service, CRUD; MODIFY)

**Analog:** itself (lines 19-45) plus `atomic-write.ts` (temp file in same dir then rename) and `write-trap.ts` `withEvaFsWrite`. Add `edit`, `create`, `readStamp` inside the same factory; every write must go through `accept()` then `withEvaFsWrite(...)`.

```typescript
export function createEvaFs(opts: { root: string }): EvaFs {
  const { root } = opts
  const accept = (kind: string, relPath: string): string => {
    const m = matchWrite(kind, root, relPath)
    if (!m.ok) throw new EvaFsDenied(kind, relPath, m.reason)
    return m.abs
  }
  return {
    async write(kind, relPath, data) {
      if (kind === 'job-delete') throw new EvaFsDenied(kind, relPath, 'use remove() for job-delete')
      const abs = accept(kind, relPath)
      await withEvaFsWrite(() => atomicWrite(abs, data))
    },
    async remove(kind, relPath) { /* job-delete only, fs.promises.rm recursive */ },
  }
}
```

Serialise per path with a queue shaped like `apps/desktop/src/main/write-queue.ts` (lines 6-15; copy into eva-core because eva-core must not import from `apps/`):

```typescript
export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    enqueue<T>(fn) { const run = tail.then(fn); tail = run.catch(() => undefined); return run },
  }
}
```

Stale-write error: `throw Object.assign(new Error('...'), { code: 'changed-on-disk' })`. Tests: extend `eva-fs.test.ts` using its tmpdir setup (lines 8-14: `mkdtempSync` + `realpathSync`, `afterEach` rm).

### `packages/eva-core/src/fs/allowlist.ts` (MODIFY)

**Analog:** itself line 16. Change `NAME_RE` to `/^[a-z0-9][a-z0-9-]*$/` (runner parity). Update the existing `job-md` allowlist tests in `eva-fs.test.ts` lines 21-31 accordingly.

### `packages/eva-core/src/write-scan.test.ts` (MODIFY)

**Analog:** itself. Extend the walk (lines 38-41) to also scan `apps/desktop/src/renderer` and `apps/desktop/src/preload`; keep the `ALLOWED` set (line 8) and `packages/eva-core/src/fs/` exclusion (line 45). Spawn helpers do not match `WRITE_RE`, so `main/eva/spawn.ts` needs no allowlist entry; chokidar is read-only.

### `packages/contract/src/eva.ts` (contract; MODIFY)

**Analog:** itself (lines 3-14). Every channel is `{ input: z.object({...}).strict(), output: z.object({...}) }` inside `evaInvoke`; it is spread into `invokeContract` in `packages/contract/src/index.ts` line 23 automatically.

```typescript
export const evaInvoke = {
  'eva.sidebar': {
    input: z.object({}).strict(),
    output: z.object({
      openTodos: z.number().int().min(0),
      scheduledJobs: z.number().int().min(0),
      recent: z.array(z.object({ date: z.string(), tag: z.string().nullable(), title: z.string() })).max(8),
    }),
  },
} as const
```

New channels: `eva.dashboard`, `eva.workspace`, `eva.todo.add`, `eva.jobs.*`, `eva.habit.run`, `eva.meetings.*`. Renderer never sends paths for writes (ids and stems only; use name/stem regexes, length caps). Add a push event (`eva.changed`) in `packages/contract/src/app.ts`/`chat.ts` style event maps if chokidar is wired (`eventContract` in index.ts line 27). Update `contract.test.ts` expectations for channel lists.

### `apps/desktop/src/main/eva-ipc.ts` and sibling `eva/*-ipc.ts` (controller, request-response)

**Analog:** `main/eva-ipc.ts` (lines 1-8) and `main/chat/live-ipc.ts` lines 53-61 (multiple `handle` calls inside one `registerXIpc(ctx)`).

```typescript
import type { MainContext } from './context'
import { handle } from './ipc/handle'
export function registerEvaIpc(ctx: MainContext): void {
  handle(ctx, 'eva.sidebar', () => readSidebar(ctx.env.evaRoot))
}
```

```typescript
handle(ctx, 'chat.send', async ({ paneId, text }) => {
  await manager.send(paneId, text)
  return { accepted: true as const }
})
```

Error handling is centralised in `main/ipc/handle.ts` lines 33-44: throw `Object.assign(new Error(msg), { code: 'changed-on-disk' })` for stable kebab codes; everything else becomes `internal`. Sender check (`isAppUrl`) and Zod input/output parse are already done by `handle`; do not re-implement. Writes: create one `EvaFs` per root (`createEvaFs({ root: ctx.env.evaRoot })`) and never call `fs.write*` here (write-scan). Update the "Read-only" comment on line 5.

### `apps/desktop/src/main/eva/spawn.ts` (service, event-driven process)

**Analog:** `main/chat/omp-transport.ts` lines 1-25, 63-70 (PATH resolution, `.mjs` fakes run via node when `node` not on PATH) and `chat/shell-path.ts` (whole file, cached login-shell PATH, fixture mode uses `process.env.PATH`).

```typescript
const spawnPath = await resolveSpawnPath(this.opts.live)
const env: NodeJS.ProcessEnv = { ...process.env, PATH: spawnPath, ...(this.opts.takeExtraEnv?.() ?? {}) }
```

Reuse `nodeOnPath` logic (omp-transport.ts lines 17-25) for `.mjs` seam binaries (`EVAOS_HABIT_GATE_BIN`, `EVAOS_JOB_RUN_BIN`): run with `process.execPath` and `ELECTRON_RUN_AS_NODE=1` in the CHILD env only. Job run: `spawn(bin, argv, { cwd: root, stdio: 'ignore', detached: true })` then `child.unref()`; never signal it (omp-transport header comment: "Never signals the child"). Habit gate: `execFile` with a 15 s timeout (code in 03-RESEARCH.md "Habit gate runner"). Record calls with `registerTestHook('spawnLog', ...)` only when `ctx.env.e2e` (pattern below).

### `apps/desktop/src/main/env.ts` (config; MODIFY)

**Analog:** itself. Add `habitGateBin`, `jobRunBin`, `now` mirroring `ompBin` (lines 80-84: explicit env var, else live default, else fixture path) and add cases to `env.test.ts`.

```typescript
const ompBin = env.EVAOS_OMP_BIN
  ? env.EVAOS_OMP_BIN
  : live
    ? findOmp(env, homedir)
    : path.join(repoRoot, 'fixtures/fake-omp/fake-omp.mjs')
```

Also add the keys to the `Env` interface (lines 5-15) and the returned object (lines 98-108). `e2e/fixtures.ts` `buildLaunchEnv` (lines 31-39) needs matching defaults (`EVAOS_HABIT_GATE_BIN`, `EVAOS_JOB_RUN_BIN`), and strips inherited `EVAOS_*` (line 29).

### Test hooks (`registerTestHook`) in new main modules

**Analog:** `main/chat/live-ipc.ts` lines 31-49.

```typescript
if (ctx.env.e2e) {
  registerTestHook('chat', { dropNextBatch: ..., stats: (paneId) => ({ ... }) })
}
```

Use the same `if (ctx.env.e2e)` gate for `spawnLog`, `dialog` stubs, and a `watch` trigger.

### `apps/desktop/src/main/eva/watch.ts` (service, event-driven)

**Analog (partial):** `main/ipc/handle.ts` `emit()` (lines 48-55) for pushing to the renderer: `emit(ctx, 'eva.changed', payload)`. chokidar itself has no in-repo analog; use 03-RESEARCH.md Pitfall 10 and the `fs.watch` fallback behind one interface. Debounce 250 ms per CONTEXT.

### Renderer stores: `dashboard-store.ts`, `jobs-store.ts`, `meetings-store.ts`, `habit-store.ts` (store, request-response / polling)

**Analog:** `renderer/sidebar/sidebar-store.ts` (lines 1-107). Copy: `createStore` from `zustand/vanilla`, a `useXData(selector)` hook using `useStore`, module-level `inflight`, `start...()` that returns an idempotent disposer, `reset...ForTests`, `registerAction` for reload, window `focus` listener.

```typescript
let inflight: Promise<void> | null = null
export function refreshSidebar(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const r = await invoke('eva.sidebar', {})
      if (r.ok) sidebarStore.setState({ ...r.value, error: false, loaded: true })
      else sidebarStore.setState({ ...initial(), error: true, loaded: true })
    } catch { sidebarStore.setState({ ...initial(), error: true, loaded: true }) }
    finally { inflight = null }
  })()
  return inflight
}
```

Needed change for DASH-06: add the queued follow-up flag (03-RESEARCH.md Pattern 2). Hotkey caution: `runAction` calls only the LAST registered handler (`router.ts` lines 45-52), so one `reloadActive()` must itself call `refreshSidebar()` (open question 4). `startSidebar` registers `reload` at line 86; the new registration must fan out to it.

Optimistic write with revert and toast (for job enable switch, habit edits): `renderer/settings/settings-store.ts` lines 13-70:

```typescript
function fail(): void { notifications.show({ color: 'red', message: SAVE_ERROR_COPY, autoClose: 8000 }) }
export function setSetting(key, value) {
  const previous = settingsStore.getState()[key]
  settingsStore.setState({ [key]: value })
  /* save in order per key; on failure revert + fail() */
}
```

Store tests: mock `../ipc` exactly as `sidebar-store.test.ts` lines 3-4: `vi.mock('../ipc', () => ({ invoke: (...a) => invoke(...a), on: () => () => {} }))`.

### Pages: `DashboardPage.tsx`, `WorkspacePage.tsx`, `JobsPage.tsx`, `HabitsPage.tsx`, `MeetingsHome.tsx`, `MeetingPage.tsx`

**Analog:** `renderer/pages/PlaceholderPage.tsx` (lines 35-53) for the page root contract, and `renderer/settings/ChatSection.tsx` for Mantine control + card row styling.

```tsx
export function PlaceholderPage({ place }: { place: Place }) {
  const meta = pageMeta(place)
  return (
    <div className="eva-page" data-testid={`page-${meta.slug}`}>
      <div className="eva-page-col"> ... </div>
    </div>
  )
}
```

Page roots must keep `data-testid="page-<slug>"` (dashboard, jobs, habits, meetings, workspace, meeting). Render all file-derived text as React children only (no `dangerouslySetInnerHTML`, T-02-35). Attach entrance cues from `renderer/styles/motion.css` (`.eva-cue-hero`, `.eva-cue-first-card`, ... with `--i`). Switch rows: `ChatSection.tsx` lines 19-26 (`Switch` with `className="eva-switch"`, `data-testid`, `aria-label`).

### Page registry dispatch: `pages/registry.ts`, `PageRouter.tsx`, `page-meta.ts`, `tabs/tab-meta.ts` (MODIFY)

**Analog:** themselves. `registry.ts` (lines 9-15) maps `PageRegistryKind` to a component; `PageRouter.tsx` line 15 picks `pageRegistry[meta.kind]`. Add a slug dispatcher component for kind `page`:

```tsx
const Page = pageRegistry[meta.kind as PageRegistryKind] ?? pageRegistry.page   // PageRouter.tsx:15
```

Make `pageRegistry.page` a small `PageBySlug` that returns `DashboardPage`/`JobsPage`/`HabitsPage`/`MeetingsHome` by `pageMeta(place).slug` and falls back to `PlaceholderPage`; set `workspace: WorkspacePage`, `meeting: MeetingPage`. `page-meta.ts` lines 101-115 return the raw id/stem as title: look up names from stores with fallback. Update `page-meta.test.ts`, `PageRouter.test.tsx`, `sidebar.test.tsx` (meetings empty copy in `SubPages.tsx` line 18), and `e2e/pages.spec.ts` in the same plan (Pitfall 12).

### `renderer/sidebar/SubPages.tsx` (MODIFY: meetings body)

**Analog:** itself. The `COPY.meetings` placeholder (lines 15-19) and `sidebar-sub-empty` block (lines 96-100) are replaced for `level === 'meetings'`; keep `SearchBox` (lines 85-92) wired to a real query, and `ScrollArea fadeBg="var(--eva-chrome)"` (line 95). Rows use `eva-sb-row` buttons with `openPlace(placeOf('meetings', ...), { newTab: e.metaKey })` like line 63 and line 29. Meeting detail place is `{ page: 'meetings', meeting: stem }`.

### `renderer/todo/NewTodoModal.tsx`, `renderer/jobs/JobForm.tsx` (component, CRUD)

**Analog:** `renderer/overlay/EvaModal.tsx` (lines 17-43) which already composes `useOccludeBrowser(opened)` and `useDismissable(DISMISS_PRIORITY.overlay, onClose, opened)`.

```tsx
export function EvaModal({ opened, onClose, title, size = 400, testid, children }: EvaModalProps) {
  useOccludeBrowser(opened)
  useDismissable(DISMISS_PRIORITY.overlay, onClose, opened)
  /* Modal.Root zIndex 300, closeOnEscape false, transition from overlayTransitionDuration() */
}
```

Never use raw Mantine `Modal`/`Menu`/`Popover` (`overlay-lint.test.ts` fails). Register `new-todo` with `registerAction('new-todo', ...)` (`router.ts` lines 32-42; returns a disposer). Job form drafts register with `registerDirty(id, { label: 'Job <name>', save })` from `renderer/dirty/dirty-store.ts` lines 21-31. Select/inputs: Mantine core, as in `settings/*`.

### `renderer/habits/GateOverlay.tsx` (component, request-response)

**Analog:** `renderer/overlay/overlay-store.ts` lines 33-40 (`useOccludeBrowser(open)`; occlusion invokes `browser.setOccluded`) and `EvaModal.tsx` structure. Not an `EvaModal`: custom root at z-index 400, `role="dialog" aria-modal`, mounted from `App.tsx` so it works on any page; call `useOccludeBrowser(true)` while mounted. Chord suppression: add a "gate locked" check at the top of `dispatchChord` in `renderer/hotkeys/router.ts` (lines 78-92) so only `cmd+q` passes.

```tsx
export function useOccludeBrowser(open: boolean): void {
  const id = useId()
  useEffect(() => { if (!open) return; addOverlay(id); return () => removeOverlay(id) }, [open, id])
}
```

Countdown: 1 s ticker from `active.endsAt` in the renderer, independent of the 4 s poll. Native file dialog goes through main `dialog.showOpenDialog`, stubbed in e2e via `app.evaluate`.

### `renderer/ui/ActivityChart.tsx` (component, transform)

No in-repo analog (no chart exists yet). Use 03-RESEARCH.md Pitfall 2 spike (Mantine `CompositeChart` + `referenceAreas`, else Recharts `ComposedChart` + `ReferenceArea fill="url(#hatch)"`). Colors via `var(--eva-c-*)`. Import `@mantine/charts/styles.css` in `renderer/main.tsx` after the core styles. Keep data prep (`dailyActivity`, week index) in `eva-core` pure functions because Recharts renders 0x0 in jsdom.

### `renderer/main.tsx` (MODIFY)

**Analog:** itself. Change `<Notifications position="bottom-left" />` to `bottom-right` (D12) and check e2e/specs that assume left; add the charts stylesheet import.

### Fixtures and test doubles

**Analog (fake gate / fake job-run):** `fixtures/fake-omp/fake-omp.mjs` lines 1-30: shebang, dependency-free ESM, `argv` helper, `LOG` env var that appends JSON lines (`appendFileSync(LOG, JSON.stringify({ t, event, detail }) + '\n')`), deterministic output. Fake gate must be stateful via a JSON file in a temp dir, print the full status JSON on every command, `{"error": "..."}` with exit 1 on failure, support a locked scenario flag, and log argv. Fake job-run writes `jobs/.runs/<name>.lock` then `<runId>/status.json` into the fixture root's temp copy.

**Analog (fixture tree):** `fixtures/eva-root/**` (README, `jobs/*/job.md`, `memory/{journal,todos,todos-done}.md`, `workspaces/{alpha,beta}.md`). Do not change it (Phase 2 sidebar specs depend on it: 2 todos, 1 scheduled job). New richer tree goes in `fixtures/eva-p3/`.

### e2e specs and helpers

**Analog:** `apps/desktop/e2e/fixtures.ts` (lines 23-99) and `e2e/sidebar.spec.ts`. Copy: `import { test, expect } from './fixtures'`, `test.use({ startOnChat: false, colorScheme: 'dark' })`, selectors by `data-testid`, `shell.evaluate(() => window.__evaosShell.tabs())` helpers, native-view visibility via `app.evaluate(() => globalThis.__evaosTest.hooks.browser.host.activeView().getVisible())` (sidebar.spec.ts lines 27-30).

```typescript
await expect(shell.locator(sel('count-tasks'))).toHaveText('2')
```

Specs that write must copy a fixture to a temp dir and pass `launchEnv: { EVAOS_EVA_ROOT: tmp }` (the `launchEnv` option fixture, fixtures.ts line 55). The shared `EVA_FIXTURE_ROOT` (helpers/paths) must stay read-only. Screenshots through `helpers/proofShot.ts` into `proof/phase-3/`.

## Shared Patterns

### IPC with `{ok, value|error}` results and stable error codes
**Source:** `apps/desktop/src/main/ipc/handle.ts` lines 16-46; renderer wrapper `apps/desktop/src/renderer/ipc.ts` lines 10-15.
**Apply to:** every new main handler and renderer store call.
```typescript
const r = await invoke('eva.sidebar', {})
if (r.ok) { /* r.value */ } else { /* r.error */ }
```
Handlers throw `Object.assign(new Error(msg), { code: 'kebab-code' })` for known failures; Zod input is `.strict()`.

### Single guarded writer
**Source:** `packages/eva-core/src/fs/eva-fs.ts` + `allowlist.ts` + `write-trap.ts` (`withEvaFsWrite`); `write-scan.test.ts` enforces it.
**Apply to:** todo append, job create/edit/enable/delete, meeting accept/dismiss. Habit data is written only by the CLI.

### Env seams, fixture defaults, refusal of the real root
**Source:** `apps/desktop/src/main/env.ts` lines 64-109.
**Apply to:** `EVAOS_HABIT_GATE_BIN`, `EVAOS_JOB_RUN_BIN`, `EVAOS_NOW`; non-live defaults to fakes.

### Overlays hide the native browser view
**Source:** `renderer/overlay/overlay-store.ts` `useOccludeBrowser`; `EvaModal.tsx`.
**Apply to:** New Todo modal, job form/delete confirmation, gate overlay.

### Single-flight refresh and idempotent start
**Source:** `renderer/sidebar/sidebar-store.ts` `refreshSidebar`, `startSidebar`.
**Apply to:** all new stores; extend with one queued follow-up.

### Dirty registry
**Source:** `renderer/dirty/dirty-store.ts` `registerDirty`.
**Apply to:** job form drafts.

### No em dashes in UI strings
**Source:** `scripts/lint-em-dash.ts` (flags U+2014 in TS string literals, template text, JSX text; ignores comments). Write parser separators as `'—'`.

### Text-only rendering
Render file-derived content as React children (T-02-35). No markdown renderer or `dangerouslySetInnerHTML` in this phase.

### Tests colocated
Vitest tests sit beside sources (`*.test.ts`, `*.test.tsx`); tmpdir setup from `eva-fs.test.ts` lines 8-14; renderer store tests mock `../ipc` as in `sidebar-store.test.ts` lines 3-4.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `renderer/ui/ActivityChart.tsx` | component | transform | No charting code exists; use the research spike (hatch via Mantine or Recharts) |
| `main/eva/watch.ts` (chokidar part) | service | event-driven | No file watcher in repo; only `emit()` push is reusable |
| `packages/eva-core/src/clock.ts` | utility | transform | No injectable clock yet; follow the `env.ts` seam style (`EVAOS_NOW`) |
| `renderer/habits/GateOverlay.tsx` (chord lock) | component/middleware | event-driven | Only the occlusion half has an analog; the "locked" flag in `dispatchChord` is new |

## Metadata

**Analog search scope:** `packages/eva-core`, `packages/contract`, `apps/desktop/src/{main,renderer}`, `apps/desktop/e2e`, `fixtures/`
**Files read:** ~35
**Pattern extraction date:** 2026-10-15
