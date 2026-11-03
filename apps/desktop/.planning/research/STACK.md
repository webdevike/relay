# Technology Stack

**Project:** EvaOS Electron (port of Rust/gpui EvaOS)
**Researched:** 2026-10-14
**Method:** every version below was read from the npm registry on 2026-10-14 (`npm view`), plus Electron's release feed, Node docs and Playwright docs. API-behaviour claims that come from training knowledge (not re-verified) are marked LOW or MEDIUM.

## Version policy

Pin exact versions (no carets) for the "platform" layer (Electron, electron-vite, Vite, TypeScript, node-pty, Playwright, Vitest). Caret ranges are fine for leaf libraries. The Mantine packages must all be the same exact version (`@mantine/charts` peer-pins `@mantine/core` to `9.7.2`).

## Recommended Stack

### Core platform

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Electron | **44.7.2** (exact; `latest` dist-tag) | Shell, main process, WebContentsView browser | Latest stable on 2026-10-14. Ships Chromium 152.0.7977.149 and Node 24.21.0. 45.0.0-beta.3 exists but is beta; do not use. 44.x is the supported line, so staying on `44-x-y` gives patch fixes. Node 24.21 matters: `node:sqlite` is built in (see SQLite). | HIGH |
| Node.js (dev) | **24.x LTS** (this machine: v24.22.0) | Tooling runtime | Matches Electron's embedded Node 24, so main-process code and Vitest `node` projects behave the same. electron-vite 6 needs `^20.19 \|\| >=22.12`, better-sqlite3 13 needs >=22 (not used). | HIGH |
| TypeScript | **~6.0.3** (do NOT take 7.0.2) | Language | `typescript-eslint` peer range is `>=4.8.4 <6.1.0`, so TS 7 (npm `latest` = 7.0.2) breaks linting. Relay already uses `~6.0.3`; stay identical so shared types and configs port. Revisit TS 7 once typescript-eslint widens its range. | HIGH |
| React / React DOM | **19.3.1** | UI | Mantine 9 requires `react ^19.2`. | HIGH |
| Vite | **8.3.4** | Renderer bundler | Vite 8 is Rolldown-based; `@vitejs/plugin-react` 6.1.2 requires `vite ^8`; electron-vite 6 supports `^6 \|\| ^7 \|\| ^8`. | HIGH |
| @vitejs/plugin-react | **6.1.2** | JSX transform, Fast Refresh | Only version compatible with Vite 8 (peer `vite ^8`). | HIGH |
| electron-vite | **6.0.0** | Scaffolding and dev/build for main + preload + renderer | See "Scaffolding decision" below. v6 uses Rolldown, targets Electron 42, 43, 44, changelog dated 2026-10-15 (released right at our date, so see risk note). | MEDIUM |
| pnpm | **12.11.2** (`latest`) via corepack, pinned in `packageManager` | Package manager | Owner-fixed. Relay uses 9.15.0, but there is no cross-repo constraint; pin whatever `corepack` resolves and commit it. `pnpm` is not currently on PATH here: run `corepack enable` first. | MEDIUM |
| Zod | **4.6.7** | Runtime schemas for IPC payloads, omp RPC events, `ui` widget JSON, layout/chat.json | One schema source gives TS types and validation at every trust boundary. Reuse Relay's widget schemas if they are Zod-based (check `packages/protocol` before writing new ones). | HIGH |

### Scaffolding decision: electron-vite 6 + electron-builder (not Forge, not manual)

- **electron-vite 6.0.0** gives one `electron.vite.config.ts` for main, preload and renderer, HMR for the renderer, main/preload restart on change, correct ESM/CJS handling and externalisation of native deps. That is exactly the three-target build this app needs, with minimal config an unattended agent can reason about.
- **Forge + Vite plugin rejected:** the Forge Vite plugin is documented as experimental ("future minor releases may include breaking changes"), and its main/preload/renderer split is hand-wired through three config files. Its strength is packaging/signing, which this project does not need (local, unsigned). (electron-vite docs themselves point to Forge as the alternative; community reports favour Forge only for packaging pain, which electron-builder covers.)
- **Manual (vite + tsc + custom runner) rejected:** reinvents dev-restart, preload bundling and native-module externals for no gain.
- **Risk:** electron-vite 6.0.0 is brand new (changelog date 2026-10-15) and moved to Rolldown; 5.x is the fallback if main-process bundling misbehaves. Keep `externalizeDeps` default so `node-pty` is never bundled.
- Output layout: `out/main`, `out/preload`, `out/renderer`; `"main": "./out/main/index.js"`. Playwright launches that output (see Testing).
- **Do not use** the `electron-vite` bytecode feature (adds complexity, hurts debuggability, irrelevant for a local app).

### UI

| Library | Version | Purpose | Why | Confidence |
|---------|---------|---------|-----|------------|
| @mantine/core | **9.7.2** | Component library | Owner-fixed. v9 requires React ^19.2. | HIGH |
| @mantine/hooks | 9.7.2 | Hooks (`useHotkeys`, `useElementSize`, `useColorScheme`) | Same version as core (peer-pinned). | HIGH |
| @mantine/charts | 9.7.2 | `LineChart`, `BarChart`, `AreaChart` for dashboard activity (7D/30D/90D) and the `chart` ui widget | Wraps Recharts; peer `recharts >=3.2.1`. | HIGH |
| recharts | **3.10.1** | Charts engine (peer of @mantine/charts) | Install explicitly; do not let it float. | HIGH |
| @mantine/notifications | 9.7.2 | Toasts | Standard companion. | HIGH |
| @mantine/spotlight | 9.7.2 | `⌘K` global search shell | Provides the modal, keyboard nav and grouped actions; feed it from an index built in a Web Worker or main process (requirement: "off the UI thread"). | MEDIUM |
| @mantine/code-highlight | 9.7.2 | Optional code block chrome (copy button) | Supports a shiki adapter; use only if it matches the Eva theme, otherwise own `CodeBlock`. | MEDIUM |
| @tabler/icons-react | 3.49.0 | Icons | Mantine's default icon set. | HIGH |
| PostCSS: postcss, postcss-preset-mantine, postcss-simple-vars | latest | Mantine's required CSS pipeline | Mantine styles need `postcss-preset-mantine` (version not re-checked; install `latest`). | MEDIUM |
| @dnd-kit/core + @dnd-kit/sortable | 6.3.1 + latest 10.x | Chat-list category drag and drop | Stable line. `@dnd-kit/react` is 0.5.0 (pre-1.0): avoid. | MEDIUM |

**Theme editor note:** map the EvaOS theme (light + dark color keys, typography, radius, shadows) onto Mantine's `createTheme` plus CSS variables (`--mantine-*`) and a parallel set of app tokens (`--eva-*`). Live preview = rewriting CSS variables on `:root`, no React re-render. Use Mantine `ColorInput` and `ColorPicker` for the pickers.

**Layout columns:** write the draggable column edges (double-click reset, persisted widths) by hand with pointer events; `react-resizable-panels` (4.14.5) does not model the "responsive shrink order and auto-fold floor" rules and would fight them. LOW-risk either way.

### Chat rendering (core value: streaming smoothness)

| Library | Version | Purpose | Why | Confidence |
|---------|---------|---------|-----|------------|
| virtua | **0.53.5** | Virtualized chat log (`VList`) | Built for chat: dynamic item heights measured automatically, `shift` mode for prepends without scroll jump, stable bottom pinning. Pre-1.0 but actively released (2026-10-11). **Choose over** `@tanstack/react-virtual` (3.14.19), which is headless and needs hand-written measurement plus bottom-anchor logic (the exact part we must get right), and `react-window` 2.3.4, which targets fixed/known-ish rows and has no prepend anchoring. | MEDIUM (API from training knowledge; prove in the spike) |
| react-markdown | **10.1.0** | Markdown to React elements | Does not render raw HTML by default (safe), component-map override fits Mantine and the `ui`/`mermaid` fenced-block routing. | HIGH |
| remark-gfm | 4.0.1 | Tables, task lists, strikethrough | Standard. | HIGH |
| shiki | **4.5.0** | Syntax highlighting | Use `createHighlighterCore` with the JS regex engine (or Oniguruma WASM) and a small language set, plus a custom theme generated from the EvaOS syntax tokens (theme editor has "syntax tokens"). Highlight only closed fences; show a plain `<pre>` while a fence is still streaming. | MEDIUM |
| mermaid | **12.2.0** | `mermaid` fenced blocks to themed SVG | Dynamic `import('mermaid')` (about 120 MB unpacked, large chunk). `initialize({ startOnLoad:false, securityLevel:'strict', theme:'base', themeVariables: <from EvaOS theme> })`. Render only when the fence is closed; cache SVG by source hash. | HIGH |
| remend | 1.4.0 | Repairs unterminated markdown (open `**`, backticks, links) mid-stream | Small standalone helper extracted from the Streamdown ecosystem. | MEDIUM |
| dompurify | 3.4.17 | Sanitise mermaid SVG and any `ui` widget HTML-ish payloads | Defence in depth. | HIGH |

**Streaming-safe incremental markdown (the recommended design, build it ourselves):**
1. Keep the accumulating assistant text in the store as a string.
2. Split into top-level blocks with a cheap block tokenizer (`marked`'s lexer or `remark-parse` once per update only on the **last, open** block).
3. Render each **closed** block through a `React.memo`'d `<Markdown>` keyed by stable index + content hash; only the trailing open block re-parses on each flush (run it through `remend` first).
4. Coalesce incoming tokens to one store write per animation frame (see State). This makes cost O(last block), not O(message).
- **Streamdown 2.7.0** (Vercel) implements this idea but is Tailwind/shadcn-oriented and brings its own styling/plugins; adopting it fights Mantine and the `ui` widget router. Treat as a reference, not a dependency.
- Do **not** use `rehype-raw` (arbitrary HTML from model output).
- Do **not** run `react-markdown` on the whole message on every token.

**Rich `ui` widgets:** a registry `Record<type, React.FC<Props>>` validated by Zod discriminated unions; widgets map to Mantine (`Badge`, `Card`, `Table`, `Tabs`, `Timeline`, `Progress`, `Avatar`, `Collapse`, `Image`, `Callout`/`Alert`, `Input`) and `@mantine/charts` (chart line/bar). Extras: diff = `diff` 9.0.0 for hunks plus a custom renderer (skip `react-diff-viewer-continued` 4.4.0, it brings emotion styles that clash with Mantine's CSS-modules approach); audio = native `<audio controls>` first (wavesurfer.js 8.0.2 only if showcase demands waveforms); gallery = Mantine `Image` + `Modal`. Widget actions flow back through one `onAction(widgetId, payload)` callback to the composer/RPC.

**Code editor for Files panel:** CodeMirror 6 via `@uiw/react-codemirror` 4.25.12 (lazy-loaded). Monaco (`@monaco-editor/react` 4.7.0) needs worker plumbing under Vite+Electron and is far heavier; the panel is "preview, explicit save", not an IDE.

### State management

| Technology | Version | Why | Confidence |
|------------|---------|-----|------------|
| zustand | **5.0.15** | Primary store. Stores live outside React, so the main-process stream handler can `setState` directly; selectors keep re-renders narrow (a streaming message re-renders one row). `subscribeWithSelector` for non-React consumers; `persist` NOT used for layout (layout goes to `layout.json` via IPC). | HIGH |
| jotai 3.0.1 | not recommended | Atom graphs are nicer for derived form state, but we have one dominant need (high-frequency append-only event streams), and one store model is simpler for agents to follow. Do not mix. | MEDIUM |

**Streaming pattern:** main process parses omp stdout lines, tags each with a monotonically increasing `seq` per session, buffers and flushes to the renderer at most every ~16 ms (`webContents.send` batch array). Renderer reducer asserts `seq` contiguity (detects dropped/reordered tokens, which is a stated acceptance criterion) and applies batches in a single `setState`. For very high volume consider `MessageChannelMain` (port transferred to the renderer) instead of `ipcRenderer.on`. LOW (design recommendation, validate in spike).

### IPC typing: hand-rolled typed channels (not electron-trpc)

- **electron-trpc 0.7.1 last published 2024-12-07** (stale; the community fork `trpc-electron` 0.1.2 last published 2025-01). Both pin old tRPC majors. Avoid.
- Recommended: one shared `ipc-contract.ts` with
  - `invoke` channels: `type Invoke = { 'fs:read': { in: FsReadIn; out: FsReadOut }, ... }`, each with a Zod schema pair,
  - `event` channels (main to renderer): `type Events = { 'omp:batch': OmpBatch, ... }`.
- Main registers handlers via `handle<K extends keyof Invoke>(k, fn)` that validates input with Zod and returns a `{ok, value | error}` result (never throw across IPC). Preload exposes exactly one `window.eva = { invoke, on }` through `contextBridge` (generic over the contract; no `ipcRenderer` leak). Renderer imports types only.
- Electron flags: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for the app window; validate `event.senderFrame` URL in handlers so the embedded browser views can never call app IPC (they get no preload anyway).
- `@electron-toolkit/utils` 4.0.0 / `@electron-toolkit/preload` 3.0.2 exist but are optional sugar; skip to keep the preload surface tiny.

Confidence: HIGH on the decision, MEDIUM on exact shape.

### Browser panel: WebContentsView (not BrowserView, not `<webview>`)

- `new WebContentsView({ webPreferences: { partition: 'persist:eva-browser', sandbox: true, contextIsolation: true } })`, added with `win.contentView.addChildView(view)`; one view per subtab, `setVisible(false)` for inactive tabs (keeps page state). BrowserView is deprecated; `<webview>` is discouraged and flaky.
- **Bounds sync:** the renderer measures a placeholder `div` with `ResizeObserver` plus layout events and sends rects to main (`view.setBounds`, device-independent pixels, round to integers, coalesce per frame). Main owns truth.
- **Critical seam (same class of bug as the gpui app):** a WebContentsView is a native layer ABOVE the renderer DOM. Mantine modals, popovers, menus, tooltips, the `⌘K` spotlight and the Eregon floating chat that overlap the panel will render underneath it. Mitigation: a `useNativeViewOcclusion()` hook that hides the view (or swaps in a `capturePage()` snapshot) while any overlay overlapping the panel rect is open. Plan this in the browser phase, not later.
- **DevTools:** `view.webContents.setDevToolsWebContents(devToolsView.webContents)` then `openDevTools()` to dock DevTools in a second WebContentsView (or `openDevTools({ mode: 'detach' })` for a window).
- **CDP:** `webContents.debugger.attach('1.3')` + `sendCommand` (Page, Runtime, DOM, Network). Only one debugger client can attach at a time; DevTools docking uses the same connection path, so test that DevTools and our CDP client coexist (they generally do via the multi-client protocol; verify). Use CDP for navigation history, title/favicon, screenshot, and agent page control.
- Title following: `page-title-updated`, `did-navigate`, `did-navigate-in-page`, `page-favicon-updated`. Address-bar resolution (URL / search / bare local port like `3000`) is pure TS, unit-test it in Vitest.
- `setWindowOpenHandler` routes `target=_blank` to a new subtab; "open in default browser" uses `shell.openExternal` (allow-list `http/https`).
- Permissions: `session.setPermissionRequestHandler` deny-by-default for the browser partition.

Confidence: HIGH on API choice; MEDIUM on DevTools+CDP coexistence details.

### Terminal

| Library | Version | Purpose | Why | Confidence |
|---------|---------|---------|-----|------------|
| node-pty | **1.1.0** (`latest`) | PTY in the main process | Ships **N-API prebuilds** (`prebuilds/darwin-arm64/pty.node` + `spawn-helper` verified in the tarball), so no per-Electron-ABI rebuild is needed on Apple Silicon. Still run `@electron/rebuild` 4.2.1 as a fallback only if the prebuild fails to load. | HIGH |
| @xterm/xterm | **6.0.0** | Terminal emulator (new scoped package; the old `xterm` package is deprecated) | Current major. | HIGH |
| @xterm/addon-fit | 0.11.0 | Fit to container | Debounce with ResizeObserver, then `pty.resize`. | HIGH |
| @xterm/addon-webgl | 0.19.0 | GPU renderer | Load after `open()`, handle `onContextLoss` by disposing and falling back to the canvas/DOM renderer. | HIGH |
| @xterm/addon-unicode11 | 0.9.0 | Correct wide-char widths | Needed for emoji and CJK. | HIGH |
| @xterm/addon-serialize | 0.14.0 | Snapshot scrollback | For restoring a pane when the panel is re-mounted (keep the PTY alive in main, re-attach the view). | MEDIUM |
| @xterm/addon-web-links | 0.12.0 | Clickable links | Route clicks to the browser panel. | HIGH |

- Spawn `$SHELL -l` with `cwd=/Users/ike/Eva`, `name:'xterm-256color'`, env with `TERM_PROGRAM=EvaOS`. Track each PTY's pid; on close send `SIGHUP` to the process group (`process.kill(-pid, 'SIGHUP')`), then `SIGKILL` after a grace period, **only for groups this app spawned** (requirement). Kill all on `before-quit`.
- Theme: build the xterm `theme` object (16 ANSI colors) from the EvaOS theme tokens; re-apply on theme change.
- Data path: PTY `onData` to renderer in batches (same 16 ms coalescing), renderer `term.write`; apply flow control (`pause`/`resume` or write callbacks) so a runaway `yes` does not freeze the UI.
- **Terminal focus isolation for hotkeys:** capture keydown at the xterm container (`attachCustomKeyEventHandler`) and let only a whitelist of app chords escape.
- Alternative considered: `@lydell/node-pty` 1.2.0-beta.15 (prebuilt per-platform optional deps, beta). Fallback only if node-pty's packaging causes trouble. LOW.
- pnpm gotcha: pnpm (v10+) blocks dependency build scripts by default. Add `node-pty` (and `electron`, `esbuild`/`@swc/core` if present) to `pnpm.onlyBuiltDependencies` (or `pnpm-workspace.yaml` equivalent), otherwise `electron` binary download and any gyp fallback silently skip. HIGH.

### Data, files, parsing

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| chokidar | **5.0.0** (ESM-only, Node >=20.19) | Watch `memory/`, `workspaces/`, `jobs/`, `work/items`, `work/meetings`, `habits.yml`, `~/.omp/agent/sessions` | Mature, glob-free in v4+. Watch **narrow explicit paths**, never the whole `/Users/ike/Eva` (node_modules, .git, large work dirs). Use `awaitWriteFinish` for editor saves and debounce 100-250 ms per path set; also reload on window `focus` as the Rust app does. Runs in main only. `@parcel/watcher` 2.6.0 (native, FSEvents) is the fallback if CPU/descriptor use is high on big trees. | MEDIUM |
| yaml | **2.9.1** | `habits.yml`, job frontmatter, meeting/work item YAML | Maintained, YAML 1.2, comment-preserving `Document` API (useful if we ever write YAML back, which we mostly do not). | HIGH |
| Frontmatter | hand-rolled 15-line splitter + `yaml` | `workspaces/<id>.md`, `jobs/<name>/job.md` | **Not `gray-matter` 4.0.3** (last release 2019, bundles old js-yaml 3, eval-capable JS front matter engines). Split on a leading `---\n...\n---`, parse with `yaml`, validate with Zod. | HIGH |
| Todos/journal parsing | plain line parsers in `packages/core` | `memory/todos.md`, `memory/journal.md` | These are line-oriented conventions, not CommonMark; a markdown AST adds nothing and makes "append a correctly numbered row after the last open row" harder. Unit-test heavily against fixtures copied (read-only) from the Eva checkout. | HIGH |
| node:sqlite | built into Electron 44 (Node 24.21) | Read Arc browser history (and any other read-only DB) | **Prefer over better-sqlite3.** `require('node:sqlite')` is Stability 1.2 (release candidate since Node 24.15), needs no flag, supports `new DatabaseSync(path, { readOnly: true })`, and requires **no native rebuild or asarUnpack**. Arc keeps its `History` DB locked/WAL-active, so **copy the file (plus `-wal`/`-shm`) to a temp dir and open the copy read-only**. Verify node:sqlite is exposed inside Electron's main process in a 5-minute spike (expected yes, it is Node's own module). | MEDIUM |
| better-sqlite3 | 13.0.3 (fallback) | Same | Only if `node:sqlite` fails inside Electron. Needs `@electron/rebuild`, `asarUnpack`, and `engines node >=22`. | MEDIUM |
| write safety | `node:fs` + temp-file-then-rename | job.md, todos, layout.json, inbox.jsonl | Atomic write helper in one shared module; append via `fs.appendFile` for `inbox.jsonl`. Do **not** add `electron-store` 12.0.0: layout/chat state have fixed file names and shapes defined by the Rust app. | HIGH |

### Process management and logging

- omp session: `child_process.spawn('omp', ['--mode','rpc-ui','--resume', file], { stdio:['pipe','pipe','pipe'] })` in the main process, owned by a `SessionManager`. Split stdout with `StringDecoder` + a manual `\n` splitter (not `readline`, which also splits on U+2028/2029 that can appear inside JSON strings when the encoder does not escape them). One JSON object per line; unknown event types are logged and ignored (forward compatible). Never `kill` a process you did not spawn (watching sessions run elsewhere is read-only via the session files).
- electron-log 5.4.4 for main-process file logs under the EvaOS config dir. Optional; `console` plus a ring buffer is enough for the spike.
- `ELECTRON_RUN_AS_NODE` stays unset for the app; spawn external CLIs (`bun`, `omp`) with an augmented `PATH` (GUI-launched apps on macOS do not inherit shell PATH: resolve it once via `$SHELL -ilc 'echo $PATH'` at startup). HIGH.

### Testing

| Technology | Version | Purpose | Confidence |
|------------|---------|---------|------------|
| vitest | **5.0.4** | Unit and component tests | HIGH |
| @testing-library/react + @testing-library/user-event + jsdom (or happy-dom) | latest | Renderer component tests | MEDIUM |
| @playwright/test | **1.64.1** | `_electron` end-to-end and proof screenshots | HIGH |

**Vitest layout (one root config, `projects`):** Vitest 5 uses `projects` (the old `workspace` file is gone). Three projects:
```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'main',     environment: 'node',  include: ['src/main/**/*.test.ts', 'packages/**/*.test.ts'] } },
      { test: { name: 'preload',  environment: 'node',  include: ['src/preload/**/*.test.ts'] } },
      { plugins: [react()], test: { name: 'renderer', environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'], setupFiles: ['src/renderer/test/setup.ts'] } },
    ],
  },
})
```
Setup file for renderer: `window.matchMedia`, `ResizeObserver`, `scrollTo` stubs (Mantine needs them) and a typed fake `window.eva`. Mock the `electron` module (`vi.mock('electron')`) in main tests; keep Electron-touching code behind thin adapters so 90% of logic (parsers, address-bar resolver, seq reassembly, todo numbering, theme math) is pure and runs without Electron. Peer: `@types/node` `^22 || >=24`: install `@types/node@^24` (not 26, the registry `latest`), to match Electron's Node 24. Virtualized lists do not lay out in jsdom; test chat scroll behaviour in Playwright, not Vitest.

**Playwright `_electron` setup:**
- `playwright.config.ts` with `testDir: 'e2e'`, `workers: 1` (one app at a time; screenshots deterministic), `timeout: 60_000`.
- Fixture launches the **built** app: `_electron.launch({ args: ['.'], cwd: repoRoot, env: { ...process.env, EVAOS_CONFIG_DIR: tmpDir, EVAOS_EVA_ROOT: fixtureRoot, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } })` after `pnpm build`; `firstWindow()` for the shell. Electron support in Playwright is documented as **experimental**, requires Electron >= 21 (we are fine).
- Isolate state with a temp `userData` dir (`app.setPath('userData', process.env.EVAOS_USER_DATA)` when set) so runs never touch Isaac's real config.
- **Fake omp:** ship `e2e/fixtures/fake-omp.ts` (a Bun/Node script emitting scripted JSON lines with deterministic delays, including a seq/ordering stress case) and select it via `EVAOS_OMP_BIN`. Tests must never attach to Isaac's live sessions.
- Keep the `EnableNodeCliInspectArguments` fuse **enabled** (default); Playwright's launch times out if it is disabled.
- Native dialogs are not intercepted; stub them with `electronApp.evaluate(...)`.
- **Screenshot pitfall (important for `proof/`):** `page.screenshot()` captures only the renderer's DOM. A WebContentsView is a separate native surface and is **not** in that image, and `webContents.capturePage()` on the window's own webContents also excludes child views. For browser-panel proof, combine (a) `page.screenshot()` for the shell, (b) `view.webContents.capturePage()` via `electronApp.evaluate` for each view, or (c) macOS `screencapture -l <CGWindowID>` of the whole window (needs Screen Recording permission; may not be grantable unattended). Plan (a)+(b) composite as the default. Whether Playwright exposes WebContentsView pages via `electronApp.windows()` was not verified: LOW, test early.
- Playwright traces on first retry; video off (cost).

### Packaging: electron-builder 26.15.3 (local, unsigned, macOS arm64)

- `electron-builder` config in `electron-builder.yml`: `appId: dev.eva.evaos`, `mac: { target: [{ target: dir, arch: arm64 }], identity: null, hardenedRuntime: false, gatekeeperAssess: false }` (add `zip` target only if a shareable artifact is ever wanted). `identity: null` skips code signing and notarization entirely. Output `release/mac-arm64/EvaOS.app`; copy to `/Applications` by hand; first launch: right-click Open or `xattr -dr com.apple.quarantine`.
- Local `dir` builds are enough for the "running app" proof. Do not set up notarization, auto-update or DMG: out of scope (no release packaging).
- `asarUnpack: ['**/node_modules/node-pty/**']` so `pty.node` and `spawn-helper` keep their executable bit and can be loaded. Confirm `spawn-helper` is `0755` in the built app (a common "posix_spawnp failed" cause).
- pnpm: electron-builder needs a hoisted-enough layout to collect production deps; set `node-linker=hoisted` in `.npmrc` for the app package (or `public-hoist-pattern`) if packaging reports missing modules. The renderer/main bundles inline everything except `node-pty`, so the production dependency set stays tiny (`dependencies: { "node-pty": "1.1.0" }`, everything else `devDependencies`, bundled by Vite).
- `@electron/fuses` 2.1.3 optional hardening (RunAsNode off, cookie encryption); skip for the spike, keep Node CLI inspect on for tests.
- **Forge rejected for packaging** (also fine technically) because we already chose electron-vite and electron-builder's mac `dir` target with `identity: null` is one line.
- No icon/entitlements work needed for local unsigned; add `build/icon.icns` only when cheap.

### Monorepo layout (conventions mirrored from Relay)

Relay: pnpm workspaces (`apps/*`, `packages/*`, `tooling/*`), Turbo, ESLint 9 flat + typescript-eslint, Prettier 3, Vitest. Mirror that so shared code can move between repos:
```
apps/desktop        electron-vite app: src/main, src/preload, src/renderer, e2e/
packages/core       pure TS: parsers (todos/journal/frontmatter), widget schemas, ipc contract, theme model
packages/ui         optional: widget components if shared later
tooling/            shared tsconfig / eslint
```
- Add Turbo (`turbo` 2.x as in Relay) only if it earns its place; with 2-3 packages `pnpm -r` is enough. Recommend **skip Turbo at first** (fewer moving parts unattended). `@eslint/js ^9.30`, `typescript-eslint ^8.35`, `prettier ^3.6` as Relay. LOW stakes.
- Keep `packages/core` free of `electron` and DOM imports so Vitest `node` runs it and a Rust-sidecar contract test can run against the same fixtures.

## Rust sidecar vs TypeScript rewrite

**Default: rewrite in TypeScript.** Most modules (dashboard parsing, todos, jobs, habits CLI polling, meetings, inbox jsonl, theme model, search index) are file parsing and are around 100-400 lines of TS each; the Rust versions are entangled with gpui types and `~68k` lines of UI code, which cannot be reused anyway.

If a module is genuinely worth reusing (a heavy, pure, gpui-free library such as a search index or digest engine), **spawn a binary, do not use napi-rs**:

| Option | Verdict | Why |
|--------|---------|-----|
| Spawn Rust binary, JSON lines over stdio | **Use** | Same transport pattern as omp RPC (one `ProcessRpc` helper serves both). Crash isolation (a panic does not take down Electron main). No ABI/rebuild concerns, works with `electron-builder` as an `extraResources` file. Contract is a Zod-validated JSON schema, testable against fixtures with Vitest. Start-up cost paid once. |
| napi-rs (`@napi-rs/cli` 3.10.8) native addon | Avoid by default | N-API is ABI-stable, so Electron loading works, but: build matrix, `asarUnpack`, a native panic or deadlock freezes the main process, and it needs the Rust toolchain (and the SDK pin noted in `apps/evaos/README.md`, `SDKROOT` workaround for Command Line Tools linker) inside the Electron build. Only consider for a hot, synchronous, in-process path; none exists today. |

Constraint: the Rust app is read-only. Do **not** add a cargo workspace dependency on `/Users/ike/Eva/apps/evaos`; copying a module into this repo and building it separately is the only allowed route. Each module's plan must record which side was chosen and why.

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Scaffolding | electron-vite 6.0.0 | Electron Forge 8.0.1 + Vite plugin | Vite plugin documented experimental; more config files; its strength (signing/makers) is unused |
| Scaffolding | electron-vite 6.0.0 | vite-plugin-electron / manual | More glue code, fewer defaults |
| Packaging | electron-builder 26.15.3 | Forge makers | Equivalent; builder's `identity: null` dir target is simplest |
| TypeScript | ~6.0.3 | 7.0.2 | typescript-eslint peer `<6.1.0`; Relay parity |
| Virtualization | virtua 0.53.5 | @tanstack/react-virtual 3.14.19 | Headless; we would write chat measuring/bottom-anchor ourselves. Fallback if virtua fails the spike |
| Virtualization | virtua | react-window 2.3.4 | No prepend anchoring, weaker variable-height ergonomics |
| Markdown | react-markdown 10 + custom block memo | Streamdown 2.7.0 | Tailwind/shadcn-shaped, conflicts with Mantine, less control over `ui` blocks |
| State | zustand 5.0.15 | jotai 3.0.1 | Event-stream-centric app; one store model |
| IPC | hand-rolled Zod contract | electron-trpc 0.7.1 | Unmaintained since Dec 2024 |
| SQLite | node:sqlite (built in) | better-sqlite3 13.0.3 | Avoids native rebuild and asarUnpack; read-only use is simple |
| Frontmatter | `yaml` + splitter | gray-matter 4.0.3 | Unmaintained since 2019, old js-yaml |
| Editor | CodeMirror 6 | Monaco | Weight and worker setup |
| Diff | `diff` 9.0.0 + custom | react-diff-viewer-continued 4.4.0 | Emotion styling clash |
| PTY | node-pty 1.1.0 | @lydell/node-pty 1.2.0-beta.15 | Beta; keep as fallback |
| Sidecar | spawn binary | napi-rs | Crash isolation, simpler build |
| Browser view | WebContentsView | BrowserView / `<webview>` | Deprecated / discouraged |

## Installation

```bash
corepack enable && corepack prepare pnpm@12.11.2 --activate

# Runtime deps (only native module stays external)
pnpm add -F desktop node-pty@1.1.0

# App libraries (bundled by Vite, so devDependencies)
pnpm add -D -F desktop react@19.3.1 react-dom@19.3.1 \
  @mantine/core@9.7.2 @mantine/hooks@9.7.2 @mantine/charts@9.7.2 \
  @mantine/notifications@9.7.2 @mantine/spotlight@9.7.2 recharts@3.10.1 \
  @tabler/icons-react zustand@5.0.15 zod@4.6.7 \
  react-markdown@10.1.0 remark-gfm@4.0.1 shiki@4.5.0 mermaid@12.2.0 remend dompurify \
  virtua@0.53.5 yaml@2.9.1 chokidar@5.0.0 diff@9.0.0 \
  @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @xterm/addon-webgl@0.19.0 \
  @xterm/addon-unicode11@0.9.0 @xterm/addon-serialize@0.14.0 @xterm/addon-web-links@0.12.0 \
  @uiw/react-codemirror @dnd-kit/core @dnd-kit/sortable

# Tooling
pnpm add -D -F desktop electron@44.7.2 electron-vite@6.0.0 vite@8.3.4 @vitejs/plugin-react@6.1.2 \
  electron-builder@26.15.3 typescript@~6.0.3 @types/node@^24 @types/react @types/react-dom \
  vitest@5.0.4 jsdom @testing-library/react @testing-library/user-event \
  @playwright/test@1.64.1 postcss postcss-preset-mantine postcss-simple-vars \
  eslint@^9.30 @eslint/js typescript-eslint@^8.35 prettier@^3.6

# pnpm-workspace.yaml / package.json: allow build scripts
#   onlyBuiltDependencies: [electron, node-pty]
```

Note: chokidar 5 is ESM-only: electron-vite 6 emits ESM for main when `"type": "module"`; keep main as ESM and verify `node-pty` (CJS) loads through `createRequire`.

## Open verification items for the spike (do these first)

1. electron-vite 6.0.0 builds main/preload/renderer cleanly and `_electron.launch` boots it (fallback: electron-vite 5.x).
2. `node-pty` 1.1.0 prebuild loads inside Electron 44 and `spawn-helper` works after `asarUnpack`.
3. `node:sqlite` readOnly open of a copied Arc `History` file inside Electron main.
4. virtua `VList` bottom-pinning plus streaming-row growth with 10k messages; fallback `@tanstack/react-virtual`.
5. Playwright visibility of WebContentsView pages and the screenshot composite approach for `proof/`.
6. WebContentsView occlusion strategy for Mantine overlays.

## Sources

- npm registry (`npm view`, 2026-10-14): electron 44.7.2, electron-vite 6.0.0, @electron-forge/cli 8.0.1, electron-builder 26.15.3, node-pty 1.1.0, @xterm/xterm 6.0.0, virtua 0.53.5, @tanstack/react-virtual 3.14.19, react-window 2.3.4, react-markdown 10.1.0, shiki 4.5.0, mermaid 12.2.0, @mantine/* 9.7.2, recharts 3.10.1, zustand 5.0.15, jotai 3.0.1, electron-trpc 0.7.1 (last modified 2024-12-07), chokidar 5.0.0, yaml 2.9.1, gray-matter 4.0.3, better-sqlite3 13.0.3, @playwright/test 1.64.1, vitest 5.0.4, vite 8.3.4, typescript 7.0.2 (latest) / 6.0.3, typescript-eslint peer `typescript <6.1.0`, @vitejs/plugin-react 6.1.2 (peer vite ^8). HIGH.
- Electron release feed https://releases.electronjs.org/releases.json (44.7.2 = Node 24.21.0, Chromium 152.0.7977.149). HIGH.
- electron-vite changelog https://raw.githubusercontent.com/alex8088/electron-vite/master/CHANGELOG.md (v6.0.0, Electron 42-44 target). HIGH.
- Node SQLite docs https://nodejs.org/docs/latest-v24.x/api/sqlite.html (Stability 1.2, `readOnly` option). HIGH.
- Playwright Electron API https://playwright.dev/docs/api/class-electron (experimental, nodeCliInspect fuse, dialogs). HIGH.
- Electron Forge Vite plugin docs https://www.electronforge.io/config/plugins/vite (experimental status) via search; MEDIUM.
- node-pty 1.1.0 tarball inspected locally (`prebuilds/darwin-arm64/pty.node`, `spawn-helper`). HIGH.
- Relay conventions: `/Users/ike/Eva/work/relay/package.json`, `pnpm-workspace.yaml`. HIGH.
- Training-knowledge-only (flagged LOW/MEDIUM inline): virtua chat ergonomics, DevTools+CDP coexistence, Playwright visibility of WebContentsView, Streamdown/remend internals, Arc DB locking behaviour.
