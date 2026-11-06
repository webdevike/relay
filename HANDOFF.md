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
- Linear read-only ENG-6810: first try FAILED (background typing in Linear's search did nothing);
  fixed by the `open_url` tool (9910b399, `open -g linear://ecard-systems/issue/<KEY>`, scheme
  allowlist https/http/linear/x-apple.systempreferences): "ENG-6810 is In Review and assigned to
  Isaac Weber.", 18 s, one step, front app unchanged (/tmp/computer-smoke/linear2/report.json).
- e2e `apps/desktop/e2e/computer.spec.ts` passes (help row, run fails "no OpenAI key" with
  OPENAI_API_KEY blanked, stop says nothing running, zero omp prompts; a non-leading `@computer`
  message still reaches omp).
- b68b9968 walk: "Keep waiting" keeps waiting on the same step (was: moved on); walk.test.ts.
- Lint: desktop's `pnpm lint` fails only on the gitignored build copy
  `apps/desktop/resources/RelayHost/Relay Host.app/.../omp-extension/*.ts` (not ours); eslint +
  prettier on our files clean; em-dash and spacing lint clean.

- Shipped: rebased, pushed main f4f5ee42 (fast-forward), deployed (published f4f5ee4288, Mini
  kicked, MBP unreachable picks it up on poll). The bundle's Helpers/Relay Assist.app answers
  `--present` with ready. 87ecf525 (SPEC sync) is local only so far.
- TextEdit leftover "Untitled" closed without saving (File > Close, Delete).

## In progress / exact next step
1. Live and walk proofs: `/tmp/computer-smoke/when-idle.sh` (log when-idle.log) waits for 120 s
   idle, then runs `bun /tmp/computer-smoke/present.ts live` and `... walk` (throwaway; aborts if
   someone touches the Mac, restores the front app; records only Calculator + the overlay via
   apps/assist/build/proofrec into /tmp/computer-smoke/<tag>/raw.mov; walk presses All Clear, 4,
   2 in the background in place of Isaac). Then ffmpeg to H.264 mp4 under proof/computer/ and look
   at frames; fix anything they show, redeploy if code changed.
2. Push the remaining commits, final report: per-mode status, proof paths, no host install, open
   questions from SPEC.md.

Checkpoint: 2026-11-06 11:02 EST
