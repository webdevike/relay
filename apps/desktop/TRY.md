# Try Relay (desktop)

An Electron + React + TypeScript port of EvaOS, named Relay. It stops after phase 4 (chat parity) on purpose. Phases 5 to 7 are deferred, not failed.

## How to open it

Installed copy (unsigned, built from this repo):

```
open ~/"Applications/Relay.app"
```

First launch may need right-click, Open, or `xattr -dr com.apple.quarantine ~/"Applications/Relay.app"`.

Important: the packaged app runs in live mode. It reads the real Eva checkout at `~/Eva` and finds the real `omp` binary. It writes only what current EvaOS writes (todos, jobs, habits, meeting accept and dismiss, chat.json, layout). Its own state lives in `~/Library/Application Support/Relay Desktop`; the first launch moves an older `EvaOS Electron` folder there.

To rebuild and reinstall after changes:

```
pnpm install
pnpm -C apps/desktop package
ditto "apps/desktop/release/mac-arm64/Relay.app" ~/"Applications/Relay.app"
rm -rf ~/"Applications/EvaOS Electron.app"  # once, after the rename
```

### Install Relay.dmg (testers, new Mac)

The dmg bundles the first-run setup wizard scripts and a prebuilt Relay Host app. Build it with:

```
pnpm -C apps/desktop package:onboarding   # builds Relay Host from this repo's apps/mac-host (RELAY_REPO overrides)
```

Output: `apps/desktop/release/Relay-<version>-arm64.dmg` (version from `apps/desktop/package.json`).

To install: open the dmg and drag Relay to Applications. The build is signed with a development identity and is not notarized yet, so the first time right-click Relay in Applications and choose Open, then Open again. Or clear the quarantine flag instead:

```
xattr -dr com.apple.quarantine /Applications/Relay.app
```

Dev mode, against fixtures and fake omp (safe): `pnpm dev`. Dev mode against real Eva and real omp: `pnpm dev:live`. Both run as **Relay Dev** (own config dir, CDP 9340 for `dev:live`, `DEV` pill in the footer); the stable app Isaac uses runs from `work/evaos-electron-live` and is updated only by `bun .omp/tools/relay-desktop-deploy.ts` (see `apps/desktop/README.md`).

Headless and test launches set `EVAOS_E2E=1` (background accessory app) and `EVAOS_HIDDEN_WINDOW=1` (transparent, click-through window) so nothing covers the screen.

## Status of this build

- Typecheck: clean.
- Unit tests (`pnpm test`): 137 files, 1064 tests, all passing.
- Build (`pnpm build`) and package (`pnpm -C apps/desktop package`): succeed.
- Playwright for Electron suite (`pnpm e2e`, with `EVAOS_PACKAGED=1` so the packaged smoke runs): 184 passed, 3 skipped (the skips are opt-in live and OS-event specs), 3.9 min, including the packaged smoke. Nothing needed fixing, so there are no code fixes in this run.

## Phases

| Phase                                           | Status   |
| ----------------------------------------------- | -------- |
| 1 Foundation, harness, chat and browser spikes  | done     |
| 2 Shell, navigation, theme tokens               | done     |
| 3 Dashboard, workspaces, jobs, habits, meetings | done     |
| 4 Chat parity                                   | done     |
| 5 Rich replies                                  | deferred |
| 6 Side panel, Eregon, global search             | deferred |
| 7 Relay, inbox, notifications, theme editor     | deferred |

## What works

- Three-column shell, sidebar, main tabs (pin, context menu), folding at narrow widths, hotkeys, overlay stack, quit guard.
- Theme tokens and bundled themes, Appearance and Settings pages (Theme and Chat). Component geometry and interactions follow native EvaOS independently of palette and font choices. The default remains the EvaOS preset. The theme editor and live preview are available; detailed remaining differences are listed below.
- Dashboard with activity charts and filters, workspace pages, New Todo (Cmd+N), jobs list and job form (create, edit, stale-on-disk refusal, Run now, delete), habits (with the locked gate overlay), meetings (Home, Detail, Accept, Dismiss), live change watching of Eva data.
- Chat: session list grouped by workspace with Pinned, search, collapse, categories with drag and drop, rename and delete, status (Working, Job, Open), virtualized transcript, streaming from a live omp session with abort and steer, composer with model, access and account pickers, image paste and drop, question cards, subagent chips, jobs strip, Claude Code bridge harness choice, new chats.
- Browser panel: real Chromium WebContentsView, address bar (URL, search, bare port), subtabs, history suggestions, DevTools, CDP page control, hides under overlays, Chrome extensions (Bitwarden from the Web Store), Arc login import.
- Browser tabs per chat: each chat (and each page, such as Dashboard or one canvas board) owns the browser tabs opened while it was in front, and switching restores its tabs and active tab. Right-click a tab to pin it; pinned tabs show in every chat. The panel opens with a chat that has its own tabs and stays closed for one without; opening or closing it by hand is remembered per chat until the app quits. A new chat keeps its tabs when it gets its session file. Only the five most recent chats keep live pages; older ones reload their tabs when you return.

### Implemented destinations only

- The menu exposes Dashboard, Chat, Test Bench, Jobs, Habits, Meetings and Settings. Workspace and meeting detail pages remain available through real data.
- Placeholder-only Inbox, Calendar, Tasks, Memory, Files, Help Center and board destinations have been removed, along with the empty Notifications settings section, Help footer and unused Eregon slot. Old saved tabs/history pointing at those pages are discarded; if no supported tabs remain, Dashboard opens. Old Notifications settings selections restore to Theme.
- The Dashboard keeps its real todo summary and list, without a dead Tasks link or a hard-coded PR count. Use workspace pages for complete workspace todo lists; New Todo remains available.
- The side panel exposes the functioning Browser only. Eregon, global search, save, model-number and copy-page-URL shortcut stubs are not registered. Sidebar search (Cmd+F), browser navigation/search and theme preview controls remain functional.
- Verified this removal: workspace typecheck and production build passed, 94 focused unit tests passed, and 49 Electron scenarios passed covering pages, sidebar, tabs, hotkeys, settings, Dashboard, watchers, New Todo and meeting actions.

Smoke check after rebuilding: launch with `EVAOS_E2E=1` for background operation, confirm only the implemented menu/settings rows appear, navigate Dashboard/Jobs/Habits/Meetings/Chat and workspace/detail pages, exercise tab history and pinning, confirm the browser stays usable across page changes, and exercise the Theme editor's interactive preview. Restore an old layout with removed pages in tab/history entries and confirm those entries cannot reopen.

Focused Electron scenarios: `pages.spec.ts`, `sidebar.spec.ts`, `tabs.spec.ts`, `hotkeys.spec.ts`, `settings.spec.ts`, `dashboard.spec.ts`, `eva-watch.spec.ts`, `new-todo.spec.ts`, and `meetings-actions.spec.ts`.

### Native component and interaction alignment

- Component spacing follows native `scale.rs` (4/10/12/16/20/32), with theme-driven input borders, focus rings, control sizes and corner radii rather than a separate Mantine accent palette.
- Chat uses a 56px header, 34px main tab strip, 780px transcript maximum, native message insets and a single rounded composer with a borderless 2-to-8-row textarea. Toolbar groups wrap at narrow widths; attachment chips show filenames and image-only prompts do not render empty bubbles.
- Resize handles capture their pointer, keep the final release position, clean up on cancel/blur/unmount and save preferred widths rather than widths temporarily squeezed by the window. Dragging is immediate; manual sidebar toggles use the native 220ms in-out transition. Automatic folding and panel toggles remain immediate. Reduced motion disables spatial transitions.
- Verification: typecheck passed, 1,072 unit tests passed, and 25 Electron scenarios passed covering composer controls/images, panel drag/reset/persistence, folding, sidebar shortcuts and motion. Before/after proof is in `proof/ux-parity/`; refreshed full-size/light/compact proof is in `proof/phase-2/`.
- Second native snapshot comparison: tab navigation now sits outside the bordered page card, page controls sit inside its header, and browser chrome follows native tool header, address row, then subtabs. New-chat content is top-aligned with the native heading and composer placeholder; duplicate central session cards were removed in favor of sidebar navigation. Tab history buttons use real history actions.
- Verified second pass: 1,074 unit tests and 184 Electron scenarios passed, 2 opt-in scenarios skipped; typecheck/build clean. Native reference captures and wide/compact Electron proof are under `proof/ux-parity/`. Escape abort retains precedence over sidebar Back while the composer is focused and replying. Category action hit targets and drag across a scrolled list are exercised.
- Settings > Theme offers a live family picker for 13 paired native families. Selection and appearance persist in the port's own `theme.json`; shared/per-mode edits and unknown document fields survive base changes. Failed saves roll back and display an error.
- Theme-picker verification: typecheck/build clean, 1,086 unit tests passed and 8 Electron settings/theme scenarios passed, including live switch without remount, Light mode, relaunch, override preservation and switching back. Screenshot: `proof/ux-parity/theme-picker.png`.
- Picker presentation follows native `theme_editor.rs`: compact Start from outline trigger, four color swatches in the trigger and each menu row, selected checkmark, separate EvaOS entry and gpui-kit themes section, 300px menu width and 460px scroll cap.
- Theme page now uses the native full-height 420px tools column and independently scrolling live Preview. Working Colors, Typography, Syntax, Other (shape), and Export sections support search, overrides, undo/redo, resets, and fully resolved dual-mode gpui-kit export. Seven preview sections use real interactive components and live theme/syntax tokens.
- Compared at 1440x900 with the side browser closed: `proof/ux-parity/native-theme-page.png` and `electron-theme-page.png`. Typecheck/build, 1,109 unit tests pass. Twenty of 21 settings/theme/shell scenarios initially passed; after controlling the OS scheme in the remaining appearance test, all five settings/editor scenarios pass.
- Remaining native theme-page differences: no installed/Google font catalog, Finder reveal, or app behavior/motion/notification/sheet property editing. Reset shared edits describes its actual scope rather than implying reset of unimplemented app settings.

## Missing versus current EvaOS

- Phase 5: streaming markdown polish, mermaid, diagram blocks, the 30 `ui` widgets and their actions.
- Phase 6: side panel Terminal, Files, Side chats and iOS Simulator tabs, Eregon floating chats, global search (Cmd+K).
- Phase 7: Relay client, inbox page and store, digests, notification preferences wiring. Theme editing and live preview have been brought forward; remaining theme-page differences are listed above.
- Claude Code transcripts are not listed or rendered in the chat list.
- `Show tool details` is a one-line fold per tool run, not the Rust group summary with tool names.
- The packaged app has the default Electron icon.

## Known bugs

- `chat-transcript.spec.ts` 5,000-message test is flaky (about 50%): the log lands near the end but not on the last-message marker. It predates phase 4.
- Recent list in the sidebar renders very short at 1280x800 (only a faded row visible).
- Bitwarden background page logs `Could not establish connection` noise on launch. Benign.
- The chat header drag region has not been proven to move the window (macOS session was locked during the check).

## Screenshots

Indexes: `proof/phase-3/README.md`, `proof/phase-4/README.md`, `proof/phase-1/HUMAN-CHECKS.md`, `proof/phase-2/CHECKLIST.md`.

- Phase 1: `proof/phase-1/chat-streaming.png`, `chat-jump-to-latest.png`, `chat-new-reply.png`, `browser-two-tabs.png`, `browser-suggestions.png`, `overlay-open.png`, `import-arc-confirm.png`, `extension-loaded.png`, `live-packaged.png`, `metrics.json`
- Phase 2: `proof/phase-2/shell-dark-1280x800.png`, `shell-light-1280x800.png`, `shell-wide-dark-1440x900.png`, `shell-folded-dark-760x720.png`, `appearance-live-switch.png`, `settings-theme-light.png`, `tabs-pinned-menu.png`, `sidebar-subpage-chats.png`
- Phase 3: `proof/phase-3/dashboard-wide-dark.png`, `dashboard-compact-dark.png`, `workspace-dark.png`, `jobs-list-dark.png`, `job-form-edit.png`, `habits-dark.png`, `gate-locked.png`, `meetings-home.png`, `meeting-detail-dark.png`, `new-todo-modal.png`
- Phase 4: `proof/phase-4/chat-list.png`, `categories.png`, `composer-toolbar.png`, `composer-model-picker.png`, `composer-images.png`, `question-card.png`, `subagent-chips.png`, `jobs-strip.png`, `settings-chat.png`, `tour-chat-compact.png`

## Verify by hand

Everything below was `still-needs-isaac` or deferred in the phase VERIFICATION files (phase 1 uses `proof/phase-1/HUMAN-CHECKS.md`, which has no VERIFICATION.md).

### Phase 1

- [ ] Chat against a real live omp session: transcript, prompt, in-order streaming, abort, steer, close (`pnpm dev:live` or the installed app).
- [ ] Subjective chat smoothness versus the gpui app (measured frame times equal idle).
- [ ] Bitwarden sign-in and autofill on a real site (needs vault credentials).
- [ ] Live Arc import with the real profile and Keychain through the app UI.
- [ ] Chat header drag region moves the window (`EVAOS_OS_EVENTS=1 pnpm -C apps/desktop e2e:run e2e/drag-region.spec.ts` on an unlocked desktop).
- [ ] Extension popup anchoring beside the panel feels right.

### Phase 2

- [ ] Native traffic-light placement (Playwright cannot render native window controls).
- [ ] Feel of slide and entrance motion.
- Deferred gaps: none.

### Phase 3

- [ ] Real habit gate: the real `habit-gate.ts` behavior and a true locked session (only the fake gate was exercised).
- [ ] Real job run: Run now with the real `job-run.ts`, and "open last session" against a live omp session.
- [ ] Real default-app launch: Open File, Open Notes, Choose photo native dialog.
- [ ] Feel and smoothness: chart animation, gate overlay opacity judgment, compact and wide reflow aesthetics.
- [ ] Real Eva data: everything was verified on fixtures; run against live `/Users/ike/Eva`.
- [ ] CR-01 todo-id contract relaxation: design judgment flagged for human review.
- Deferred gaps: none.

### Phase 4

- [ ] Chat against a real omp session on live Eva data.
- [ ] A real Claude Code run through the bridge (needs Claude Code sign-in).
- [ ] Drag feel and smoothness of chat and category reordering.
- [ ] Rename against a real running omp in a terminal.
- Deferred gap: Claude Code transcripts are not listed or rendered in the chat list.
- Deferred gap: `Show tool details` is a one-line fold per tool run, not the Rust group summary with tool names.
- Deferred gap: `chat-transcript.spec.ts` 5,000-message test is flaky (about 50%).

## Test Bench: isolated text-observation comparisons

Open **Test Bench** in the EvaOS sidebar. Choose two to four model configurations,
run the comparison, or open a saved comparison. Setup collapses when reviewing
results; per-model scorecards, case evidence and raw verdicts expand on demand.
Cancel run stops only this comparison. Saved history remains usable offline.

Build once with `pnpm build`. The CLI runs Electron main (not Node mode), creates no
shell window, and uses the same engine, schemas, scorecards and store as the UI.
All commands print one JSON result on stdout; run progress is JSON on stderr.
The Node launcher clears `ELECTRON_RUN_AS_NODE`, keeps Chromium in a separate
process group, and forwards terminal cancellation through stdin instead of
interrupting Chromium's native startup. JSON output is drained before exit.

Use a stable explicit config directory for both CLI and UI reload:

```sh
export EVAOS_CONFIG_DIR=/tmp/evaos-test-bench-proof
export EVAOS_OMP_BIN="$HOME/.local/bin/omp"
pnpm --silent test-bench models
pnpm --silent test-bench run --model jev/jev-1.13.0 --model openai-codex/gpt-5.6-luna
pnpm --silent test-bench list
pnpm --silent test-bench show <run-id>
```

The run example selects two real configurations across all 24 cases, not a smoke
subset. Use an exact omp `provider/model` returned by `models`; availability is
discovery, not a promise that a subsequent authenticated inference succeeds.
For another existing omp account, use `models --profile work` and
`run --model jev/jev-1.13.0 --profile work --model provider/model`.
`--profile current|personal|work` applies to subsequent omp `--model` flags.
Jev always uses current host credentials. Select 2–4 distinct configurations.

Jev reads `TYPESAFE_API_KEY` or `<EVAOS_EVA_ROOT>/secrets/jev.env` on the host only.
Dev mode otherwise uses the fixture Eva root; provide the existing key in the
environment for proof without switching the whole app to live mode. Never put
keys in model flags or evidence. omp uses its existing account/profile routing;
no credentials are copied, no login is added and global config is unchanged.
Account-backed Jev catalog aliases are pinned to `jev-1.13.0` (stable) and
`jev-1.14.0` (preview), confirmed in https://docs.typesafe.ai/models.md.
Returned identity is retained when supplied; absent identity/version/cost stays
unavailable. Jev probabilities remain in bounded raw typed answers, not a new
confidence-based scoring policy. Unsupported cost is never represented as zero.

Each omp judgment uses a fresh external temporary cwd, disabled tools/extensions/
skills/rules/LSP/session saving, and a pre-prompt empty-tool/zero-history/exact-model
gate. Context contract `omp-context-2026-10-20` accepts only the fixed evaluator
prompt plus the observed generic workstation/memory instructions, not memories,
workspace or session facts. Unknown startup context fails closed. Discovery uses
the same safe argv/cwd; only owned children are terminated. This asserts observed
runtime capabilities/context, not a claim about opaque provider internals.

Both routes receive digest-identical criterion, versioned rubric/skill, text
observations and limits; screenshots are human evidence, not model image inputs.
Defaults: 30s browser capture, 60s judgment, 1h comparison, 32KiB envelope,
64KiB raw answer and 8MiB PNG. `run --judgment-ms 30000 --total-ms 1800000`
can lower time limits; schema maxima remain fixed. Ctrl-C cancels owned work and
persists partial results. Exit 0: complete/qualified; 1: completed verdict mismatch
or critical failure; 2: invalid input or infrastructure failure (takes precedence
over partial cancellation); 130: cancellation without other infrastructure errors.
Valid `list`/`show` return 0 regardless of a historical run's verdict.

Results and PNG evidence live under
`$EVAOS_CONFIG_DIR/test-bench/runs/<run-id>/`. Reopen EvaOS with the same config
directory and select Test Bench to inspect saved runs, case evidence/raw answers
and version hashes. No provider calls are needed to list/show saved data.
False passes/detection use valid defective decisions; false alarms use valid clean
decisions; abstention uses valid decisions and coverage uses attempted judgments.
Infrastructure, collector failures and unattempted cases stay separate; zero
denominators are unavailable. Critical false passes veto Inspect qualification.
Repair/Build/Delegate are unassessed; this small pilot makes no production-safety
or automatic permission-promotion claim.

Focused integration proof: run the provider/CLI regression files with Vitest,
then the real two-model command above, inspect clean/defective PNGs, cancel a
separate run, inspect explicit provider errors, and reload CLI/UI against the same
config. Run rendered proof with `EVAOS_E2E=1 EVAOS_HIDDEN_WINDOW=1`; do not restart
or focus the working app. Mock tests alone are not the real 24-case acceptance.
