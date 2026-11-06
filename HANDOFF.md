# HANDOFF: @computer v1 (branch eva/computer, worktree work/relay-computer)

Read first: `SPEC.md` (design, grammar, routing, safety, open questions). Order: headless, then live,
then walk; each verified before the next. Rules: never relaunch or drive Relay Desktop's own UI to
test (composer parsing via the e2e harness, hidden window); host untouched (no host install needed
so far); desktop ships by rebase + fast-forward push main + `bun /Users/ike/Eva/.omp/tools/relay-desktop-deploy.ts deploy`.

## Done (committed)
- d18eff10 SPEC.md + this file.
- 31f7dc53 Assist `--present` mode (apps/assist/Sources/Presenter.swift; stdin JSON ops
  assistant/point/click/caption/hide/quit, stdout events ready/landed/spoken/esc/error; 170 Swift
  tests pass; smoke prints ready and exits 0; resident Assist untouched). The real overlay has NOT
  been shown yet (Isaac was active). README has a `--present` section.
- 52585767 desktop core, all in `apps/desktop/src/main/computer/`:
  command.ts (parser), route.ts (Assist routing rules + chat thread), driver.ts (cua-driver MCP
  client, `--direct` = Relay's grants, else daemon), desktop.ts (windows/read/act), safety.ts
  (gate: ask/refuse), brain.ts (OpenAI Responses, gpt-6.1-terra, key from secrets/openai.env),
  agent.ts (headless/live loop; risky steps auto-ask with screenshot), judge.ts (Jev / model),
  walk.ts (plan, point+speak, poll done), presenter.ts (spawns Assist --present), runs.ts (rows,
  approvals via `[[replies: Approve | Cancel]]`, stop/next/skip, one run per Mac, MacBook refuses),
  index.ts (registerComputer, `computer.rows` invoke). Contract: packages/contract/src/computer.ts.
  Wiring: main/chat/index.ts + live-ipc.ts (`chat.send` intercept before SessionManager.send);
  renderer/chat/computer-rows.ts + ChatPane.tsx merge rows after the session's messages.
- Unit tests: `npx vitest run --project main src/main/computer` (16 pass). `pnpm typecheck` passes.

## Headless real runs (throwaway harness /tmp/computer-smoke/run.ts + sampler.py; reports in /tmp/computer-smoke/<tag>/report.json)
- Calculator 12x7 -> 84, front app stayed Relay throughout (Isaac active, mouse moves are his).
- TextEdit new doc + type + screenshot: worked (/tmp/computer-smoke/textedit/02-TextEdit.png).
  Leftover: an unsaved "Untitled" TextEdit window is open; close it without saving.
- System Settings read-only macOS version: "27.0.1", clean idle run: idle grew 5.4 -> 17.5 s,
  mouse unchanged, front unchanged (proof of no HID input/focus change).
- Linear read-only ENG-6810: FAILED (background typing in Linear's search did nothing).

## In progress / exact next step
1. Add an `open_url` tool to agent.ts TOOLS + exec (`open -g <url>` via openInBackground-style
   execFile, background; e.g. `linear://ecard-systems/issue/ENG-6810`, https links), plus an
   instructions hint: Linear issues open by `linear://ecard-systems/issue/<KEY>`. Re-run
   `bun /tmp/computer-smoke/run.ts 'Read only, change nothing: in the Linear app, what is the status and assignee of ENG-6810?' linear`
   (expected: In Review / Isaac Weber).
2. e2e spec (apps/desktop/e2e/computer.spec.ts, pattern of e2e/new-chat.spec.ts): type `@computer`
   (help) and `@computer open Calculator` in the hidden-window app; assert FAKE_OMP_LOG has no
   'prompt' event and the chat log shows the help row / "no OpenAI key" failure row (fixture eva
   root has no secrets). `pnpm build && pnpm e2e:run e2e/computer.spec.ts --retries 0 --max-failures 1`.
3. Live: needs `RELAY_ASSIST_BIN=/Users/ike/Eva/work/relay-computer/apps/assist/build/RelayBuddy.app/Contents/MacOS/RelayBuddy`
   in a smoke harness (copy run.ts, mode 'live', startPresenter). Only when Mac idle >= 120 s
   (`ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1e9); exit}'`), stop if he touches it.
4. Walk: record a 3-step Calculator walkthrough as H.264 mp4 (apps/assist/tools/proofrec.swift
   records the display keeping given processes; ffmpeg to mp4), doing each step via cua-driver in
   place of Isaac; idle-gated as above. Proof under proof/computer/.
5. pnpm lint (em-dash lint too), pnpm test, typecheck; rebase on origin/main, fast-forward push main,
   deploy desktop. Update SPEC/HANDOFF; final report: per-mode status, proof paths, no host install,
   open questions from SPEC.md.

Checkpoint: 2026-11-06 11:02 EST
