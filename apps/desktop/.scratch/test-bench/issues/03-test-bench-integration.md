# Expose Test Bench and integrate acceptance proof

Status: COMPLETE
Review Mode: AUTO
Depends on: 02
Expected production LOC: 850
Maximum production LOC: 900
Expected files touched: 17

Budget replan (2026-10-20): original 600 expected / 700 maximum and 13 files underestimated normal project formatting and existing-contract integration fixes. Revised 850 / 900 and 16 files preserve AC1–AC9. Main also owns `apps/desktop/tsconfig.node.json` (ES2024 library matching the existing Electron runtime), `apps/desktop/src/renderer/sidebar/sidebar.test.tsx` (remove copied navigation list, retain behavior), and `packages/eva-core/src/write-scan.test.ts` (remove source-text assertions, retain runtime boundary coverage elsewhere). These three existing paths are included in this issue's machine manifest. No new product behavior or permission. Historical result counts are pre-format; final parent cap remains 3,300 LOC / 38 files.

## For Isaac

- Outcome: Test Bench opens from EvaOS navigation with real comparison controls, saved evidence and Inspect status.
- Why it matters: The pilot must be usable and inspectable without pretending it can repair, build or delegate.
- Proof: Rendered EvaOS screens show actual model results, cancellation, critical failures and results surviving restart.

## Why

Covers AC1, AC7, visible AC5/AC6 and AC9 integration across all criteria. Issue 02 supplies real providers and CLI; issue 01 supplies completed contracts, evidence, scoring and persistence. This issue wires those behaviors into existing EvaOS, not a parallel dashboard or evaluator.

## Implement

- Own exactly production paths `apps/desktop/src/main/test-bench/ipc.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/context.ts`, `apps/desktop/src/renderer/test-bench/TestBenchPage.tsx`, `apps/desktop/src/renderer/test-bench/test-bench.css`, `packages/shell-core/src/place.ts`, `apps/desktop/src/renderer/pages/page-meta.ts`, `apps/desktop/src/renderer/pages/registry.ts`. Own tests `apps/desktop/src/main/test-bench/ipc.test.ts`, `apps/desktop/src/renderer/test-bench/TestBenchPage.test.tsx`, `packages/shell-core/src/place.test.ts`, `apps/desktop/src/renderer/pages/page-meta.test.ts`, `apps/desktop/e2e/test-bench.spec.ts`. TRY.md remains issue 02's sole owner; coordinate any final example corrections there. Do not modify provider/engine/contracts to invent a second interface.
- Read the completed engine/provider result and exported contracts first. Instantiate one service with resolved configDir/Eva root and existing-auth provider factory in main; dispose on shutdown. Register thin `handle/emit` handlers for fixed `testBench.models/start/cancel/list/get/evidence` and progress. Validate sender/IDs through existing typed IPC and explicitly parse stored/model payloads even in packaged mode. Preload already derives channel allowlists; add no raw IPC/filesystem API.
- Add fixed `test-bench` place with restoration support, NAV_PAGES metadata using existing IconListCheck, and PAGE_BY_SLUG component. MainNav is metadata-driven; no new router/sidebar layer or manual duplicate navigation list.
- One focused trial/results page uses existing Mantine controls, ScrollArea and theme tokens. Select 2 to 4 actual available model/profile configurations with exact identity visible, show fixed text-observation track/rubric and limits, start promptly, cancel, show case/config progress and explicit terminal/infrastructure errors. Disable conflicting starts while active; unsubscribing/navigation must not cancel a run accidentally. Returning to the page reconciles active and saved state instead of losing it.
- Browse saved comparisons, display each configuration's identity, requested/returned model details including unresolved Jev alias, versions, timestamps/timing and available usage/cost. Render null cost as unavailable. Show development/holdout scorecards with explicit numerators/denominators, attempted/planned counts, infrastructure errors and critical false passes prominently. Never compute a second scoring interpretation in the renderer.
- Display category planned/valid/error/unattempted counts together, including pre-judgment collector failures, and interrupted saved runs as incomplete. Configuration identity includes the bounded skill/rubric content hashes; do not collapse distinct configurations into a friendly model name.
- Select a case/configuration to inspect criterion, deterministic observations, explicit missing evidence, rendered before/after PNGs and bounded raw plus validated verdict. Keep screenshots labeled as captured proof, not model vision input. Ground truths may be revealed in saved evaluation results, never passed back to a judged provider or exposed in start input.
- Display Inspect, Repair, Build, Delegate. Inspect reflects actual persisted evidence/completion/critical veto and scoped benchmark qualification only; other rungs read Unassessed. Before a run, Inspect is not yet assessed. No auto-promotion, permission switches, invented capability progress or production safety claim.
- Add behavior-driven integration/e2e cases for navigation/restore, model selection, run/progress, cancellation, provider errors, evidence drilldown, critical veto and persisted reload. Use `EVAOS_E2E=1 EVAOS_HIDDEN_WINDOW=1` with disposable stable config and fixture Eva root. Keep real-provider proof explicitly separate from deterministic test doubles. Prepare the integrated proof scenario using existing launch/proofShot helpers, never restart or focus Isaac's working app.
- Main integration owner alone executes final checks and real cross-model/browser/CLI/UI/restart proof after all slices. Include the issue results and AC evidence inline; no dock. Local integration must preserve unrelated changes and never push. This issue is not accepted on fake rendered data or unit tests alone.

## Do Not

- Do not add a chart framework, new nav subsystem, global style overhaul, placeholder metrics, fake model choices or repair/build/delegate actions.
- Do not request reapproval of these reversible implementation details: the parent quote approves this pilot. Escalate only newly discovered HIGH-impact permission/product/schema/architecture changes.
- Do not run midflight checks, real providers, builds, formatters or visual proof in this slice. Add the cases; main exercises them once after integration.

## Open Questions

### Q5: Which UI and review pattern should integrate the approved pilot?
Type: UX
Importance: LOW
Answer Format: SINGLE_SELECT
Options:
- One focused existing-shell page with result/evidence drilldown and after-implementation visual review
- Separate dashboard and multi-page route family
Comment: Optional. Per-issue AUTO overrides CHECKPOINTS for the already authorized pilot; main reviews the integrated implementation and visual proof. No new product choice or permission is approved; any HIGH divergence stops.
Agent Default: One focused existing-shell page with result/evidence drilldown and after-implementation visual review.
Status: AGENT_DECIDED
Decision: Reuse navigation metadata, Mantine, tokens and existing page layout; visual review occurs in main's final rendered proof, inline rather than dock.

## Verify

- Add IPC tests for invalid/foreign IDs, non-shell sender rejection, progress forwarding/unsubscribe and cancellation reaching only the owned engine run.
- Add UI/navigation tests for real catalog empty/error states, exact configuration selection, disabled duplicate start, progress and terminal errors, navigation-away/return, saved results and unsupported cost display.
- Add cases showing critical false passes cannot disappear in an average, zero denominators are unavailable, partial runs are not qualified, screenshots and text-observation track are distinct, and all later ladder rungs stay unassessed.
- Main's final proof must cover AC1 through AC9: two real configurations including Jev and authenticated omp on identical 24-case evidence; safe pre-prompt handshake; rendered good/defective clipping/keyboard/save cases; cancellation/error cleanup; CLI documented exits; UI/CLI reading the same saved IDs after restart; actual EvaOS screenshots and local-only integration. Report failures honestly; do not mark AC9 complete from mocked model responses.

## Visual Intent

Lead with Test Bench and the run/configuration action, then a quiet progress/result region. Use flat divided rows or one bordered comparison table, clear numeric alignment and compact evidence drilldown. Critical false passes earn visible labeled emphasis, not a decorative severity stripe. Use existing spacing/type/color tokens, subdued secondary metadata, one primary action, keyboard-accessible labeled controls and explicit empty/loading/error states. No stacked shadow cards, border-plus-shadow surfaces, all-caps eyebrows, lift hovers, glyph icons or em dashes. Show real screenshots at readable scale with before/after context. Respect narrow layouts without hiding errors or denominators.

## Existing UI Reference

Reuse `renderer/pages/pages.css`, `renderer/ui/ScrollArea.tsx`, `renderer/jobs/JobsPage.tsx` and `renderer/settings/ChatSection.tsx` for page/control conventions; `renderer/styles/tokens.css` and existing Mantine theme for styling. The earlier concept is restraint guidance only, not reusable application markup. Follow skill://isaac-design before implementation; do not introduce another design system.

Visual Review: AFTER

## Implementation Handoff

Main verification is complete: actual UI start/cancel, real saved model comparison and native PNG inspection, offline restart, three Electron scenarios, TypeScript and focused lint. Installed package was exercised with isolated data and zero page errors after correcting startup ordering. Final result records formatted accounting and exact proof. The additional tab-title mapping uses existing file headroom; no new scope or permission.
