# Try EvaOS Electron

An Electron + React + TypeScript port of EvaOS. It stops after phase 4 (chat parity) on purpose. Phases 5 to 7 are deferred, not failed.

## How to open it

Installed copy (unsigned, built from this repo):

```
open ~/"Applications/EvaOS Electron.app"
```

First launch may need right-click, Open, or `xattr -dr com.apple.quarantine ~/"Applications/EvaOS Electron.app"`.

Important: the packaged app runs in live mode. It reads the real Eva checkout at `~/Eva` and finds the real `omp` binary. It writes only what current EvaOS writes (todos, jobs, habits, meeting accept and dismiss, chat.json, layout).

To rebuild and reinstall after changes:

```
pnpm install
pnpm -C apps/desktop package
ditto "apps/desktop/release/mac-arm64/EvaOS Electron.app" ~/"Applications/EvaOS Electron.app"
```

Dev mode, against fixtures and fake omp (safe): `pnpm dev`. Dev mode against real Eva and real omp: `pnpm dev:live`.

Headless and test launches set `EVAOS_E2E=1` (background accessory app) and `EVAOS_HIDDEN_WINDOW=1` (transparent, click-through window) so nothing covers the screen.

## Status of this build

- Typecheck: clean.
- Unit tests (`pnpm test`): 137 files, 1064 tests, all passing.
- Build (`pnpm build`) and package (`pnpm -C apps/desktop package`): succeed.
- Playwright for Electron suite (`pnpm e2e`, with `EVAOS_PACKAGED=1` so the packaged smoke runs): 184 passed, 3 skipped (the skips are opt-in live and OS-event specs), 3.9 min, including the packaged smoke. Nothing needed fixing, so there are no code fixes in this run.

## Phases

| Phase | Status |
|-------|--------|
| 1 Foundation, harness, chat and browser spikes | done |
| 2 Shell, navigation, theme tokens | done |
| 3 Dashboard, workspaces, jobs, habits, meetings | done |
| 4 Chat parity | done |
| 5 Rich replies | deferred |
| 6 Side panel, Eregon, global search | deferred |
| 7 Relay, inbox, notifications, theme editor | deferred |

## What works

- Three-column shell, sidebar, main tabs (pin, context menu), folding at narrow widths, hotkeys, overlay stack, quit guard.
- Theme tokens and bundled themes, Appearance and Settings pages (Theme, Chat, Notifications). Component geometry and interactions follow native EvaOS independently of palette and font choices. The default remains the EvaOS preset; Flexoki is supported by the resolver without forcing Inter typography. Full theme editing remains deferred to phase 7.
- Dashboard with activity charts and filters, workspace pages, New Todo (Cmd+N), jobs list and job form (create, edit, stale-on-disk refusal, Run now, delete), habits (with the locked gate overlay), meetings (Home, Detail, Accept, Dismiss), live change watching of Eva data.
- Chat: session list grouped by workspace with Pinned, search, collapse, categories with drag and drop, rename and delete, status (Working, Job, Open), virtualized transcript, streaming from a live omp session with abort and steer, composer with model, access and account pickers, image paste and drop, question cards, subagent chips, jobs strip, Claude Code bridge harness choice, new chats.
- Browser panel: real Chromium WebContentsView, address bar (URL, search, bare port), subtabs, history suggestions, DevTools, CDP page control, hides under overlays, Chrome extensions (Bitwarden from the Web Store), Arc login import.

### Native component and interaction alignment

- Component spacing follows native `scale.rs` (4/10/12/16/20/32), with theme-driven input borders, focus rings, control sizes and corner radii rather than a separate Mantine accent palette.
- Chat uses a 56px header, 34px main tab strip, 780px transcript maximum, native message insets and a single rounded composer with a borderless 2-to-8-row textarea. Toolbar groups wrap at narrow widths; attachment chips show filenames and image-only prompts do not render empty bubbles.
- Resize handles capture their pointer, keep the final release position, clean up on cancel/blur/unmount and save preferred widths rather than widths temporarily squeezed by the window. Dragging is immediate; manual sidebar toggles use the native 220ms in-out transition. Automatic folding and panel toggles remain immediate. Reduced motion disables spatial transitions.
- Verification: typecheck passed, 1,072 unit tests passed, and 25 Electron scenarios passed covering composer controls/images, panel drag/reset/persistence, folding, sidebar shortcuts and motion. Before/after proof is in `proof/ux-parity/`; refreshed full-size/light/compact proof is in `proof/phase-2/`.
- Second native snapshot comparison: tab navigation now sits outside the bordered page card, page controls sit inside its header, and browser chrome follows native tool header, address row, then subtabs. New-chat content is top-aligned with the native heading and composer placeholder; duplicate central session cards were removed in favor of sidebar navigation. Tab history buttons use real history actions.
- Verified second pass: 1,074 unit tests and 184 Electron scenarios passed, 2 opt-in scenarios skipped; typecheck/build clean. Native reference captures and wide/compact Electron proof are under `proof/ux-parity/`. Escape abort retains precedence over sidebar Back while the composer is focused and replying. Category action hit targets and drag across a scrolled list are exercised.

## Missing versus current EvaOS

- Phase 5: streaming markdown polish, mermaid, diagram blocks, the 30 `ui` widgets and their actions.
- Phase 6: side panel Terminal, Files, Side chats and iOS Simulator tabs, Eregon floating chats, global search (Cmd+K).
- Phase 7: Relay client, inbox page and store, digests, notification preferences wiring, full theme editor.
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
