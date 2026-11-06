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

## Live and walk (idle-gated, throwaway harness /tmp/computer-smoke/present.ts + when-idle*.sh)
- First attempts: cua-driver's bring_to_front "not verified" error ended walk runs and cost the
  live run its open step: fixed (2a153b8d, `Desktop.front` best effort).
- live: "In Calculator, clear it, then work out 23 x 4" -> "23 × 4 = 92.", 31 s, Nova's cursor,
  caption, click marks; front app restored, no touch during the run.
  proof/computer/live-calculator.mp4 (H.264 900x640, 36 s), live-frames.png.
- walk: 3 steps (All Clear, 4, 2), harness pressed each in the background 4.5 s after the overlay
  pointed (outline, step badge, caption, voice); all 3 judged done by Jev; mouse 1173,945 before
  and after, front Relay before and after. proof/computer/walk-calculator.mp4 (52 s, no audio),
  walk-frames.png.
- aa5482b8: presenter drops Assist's "· staying" tag (seen in the proofs); walk asks Jev "already
  done?" and "which control?" in parallel (step 1 started 30 s after the plan).

## In progress / exact next step
1. `/tmp/computer-smoke/when-idle-walk.sh` (bg) reruns walk with the tag fix and PROOFREC_AUDIO=1
   into /tmp/computer-smoke/walk2; if it lands, replace proof/computer/walk-calculator.mp4 (with
   the voice, AAC) and walk-frames.png.
2. Rebase, push main, redeploy desktop (aa5482b8 + later). No host changes in this branch: the
   single host install Nova asked for is origin/main's tip after the push (it contains f5f3fa80).
3. Final report: per-mode status, proof paths, host install commit, open questions from SPEC.md.

Checkpoint: 2026-11-06 12:50 EST
