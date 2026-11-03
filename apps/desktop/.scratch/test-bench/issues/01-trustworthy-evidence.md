# Produce and persist trustworthy settings-form evidence

Status: COMPLETE
Review Mode: AUTO
Depends on: None
Expected production LOC: 1400
Maximum production LOC: 1500
Expected files touched: 12

Budget replan (2026-10-20): original 1,000 expected / 1,150 maximum underestimated normal project formatting. Revised 1,400 / 1,500 covers the same explicit fixtures, schemas, browser, scoring, storage and engine; no new scope. Historical result counts are pre-format, not final accounting. Main records final formatted measurement under the parent 3,300 LOC / 38-file cap.

Implementation and core behavior tests complete. Main ran the four Node-compatible regression files: 16 tests passed. Native Electron/browser and cross-model proof remain explicit parent integration acceptance gates, not claims made by this slice.

## For Isaac

- Outcome: A real 24-case settings-form benchmark produces saved browser evidence and honest scorecards.
- Why it matters: Model comparisons are meaningful only when observations and protected answers remain separate.
- Proof: Rendered clipping, keyboard and save/reload behavior are inspectable, and critical false approvals remain visible.

## Why

Covers AC2, AC3, AC5, AC6 and the engine portions of AC1/AC4. This is the complete evidence/scoring/storage responsibility, not a mock-backed pilot. Real adjudication is injected by issue 02; absence of an adjudicator is an explicit configuration error, never a synthetic verdict.

## Implement

- Own exactly these production paths: `packages/contract/src/test-bench.ts`, `packages/contract/src/index.ts`, and `apps/desktop/src/main/test-bench/{fixtures,browser,engine,store,scoring}.ts`. Own tests `packages/contract/src/test-bench.test.ts` and `apps/desktop/src/main/test-bench/{fixtures,browser,engine,store}.test.ts`. No provider, IPC, UI or CLI implementation here.
- Fix exported contracts before implementations: Zod DTOs in the contract module; engine-side `Adjudicator` with `models(signal)` and `judge(config, envelope, signal)`; `createTestBench({configDir, adjudicator, ...ownedBrowserOptions})` exposes `models`, promptly returning `start` (run ID, not awaited completion), `cancel(runId)`, `list`, `get(runId)`, `evidence(runId,evidenceId)`, progress subscription/unsubscribe and disposal. Define corresponding `testBench.models/start/cancel/list/get/evidence` invokes and `testBench.progress` event now. Do not return a model prompt to the renderer.
- `judge` receives only an immutable public envelope (criterion, bounded versioned rubric/skill text, deterministic observations, explicit missing evidence) and selected exact provider/model/profile/config limits. It returns bounded raw answer, validated `pass|fail|insufficient-evidence` decision with rationale, requested/returned identity and optional usage/cost; throws typed infrastructure errors. Keep labels/category/severity/split, filesystem paths, credentials and evaluator internals out of this interface. Evidence digest identifies identical serialized input for each configuration. Screenshots are stored proof, not provider image input: track name is text-observation comparison.
- Construct provider payloads by explicit allowlist, never spreading a fixture/result object. Exclude expected answers even inside nested observations, criterion prose, markup attributes and adversarial text; adversarial instructions may attack the rubric but must not disclose the host answer. Test serialized outbound payloads for planted answer sentinels, not just top-level key omission. Configuration identity hashes exact provider/model/profile, track, rubric/skill content versions and hashes, and effective limits; changing any creates a distinct configuration.
- Encode exactly 24 distinct opaque-ID cases: six each clean/defective/insufficient-evidence/adversarial; four development/two holdout per category. Individually specify criterion, prescribed action, expected verdict and severity host-side. Adversarial does not mean automatically fail. Neutral page markup/URLs must not reveal answers. Include actual label association, keyboard reachability, clipping, save/reload persistence, deliberately withheld observations and page-text instruction attacks. Derive observations from browser execution, never ground truth.
- Implement bounded Electron collection with fresh nonpersistent sessions, sandbox/context isolation, no preload/Node/extensions/cookies, deny permissions/popups/external navigation and requests except the owned loopback fixture route. Use `PageControl` fixed host-authored measurements, actual keyboard events plus activeElement, DOM/Range geometry and real before/after PNG capture. Save and reload on that origin to observe persistence. Await paint using existing inactive transparent-window conventions. A blank capture/collector failure is infrastructure error unless absence is deliberately prescribed by a case. Destroy owned window/contents/server/session on completion, abort and error.
- One service comparison at a time; sequential cases/configurations. Collect evidence once, freeze the public envelope, reuse identical digest and limits for all models. Default bounds: 2 to 4 configurations, 30 seconds per capture, 60 seconds per judgment, 60 minutes total, 32 KiB public envelope, 64 KiB raw answer, 8 MiB per PNG; record effective limits. Reject oversized data explicitly, not truncation that changes the criterion. Cancellation aborts the current owned operation and persists partial terminal state. A run must never appear completed with unattempted judgments.
- Persist generated run/config/evidence IDs, timestamps/timing, exact identities, fixture/rubric/skill versions and hashes, envelope/evidence digests, raw/validated answers, nullable usage/cost and separate run errors. Use `<configDir>/test-bench/runs/<id>/` with `createConfigStore` atomic leaf JSON writes and bounded PNG writes; parse saved JSON explicitly with Zod, report corruption. Derive history from directories, no mutable index. Evidence delivery uses validated IDs, realpath confinement and bounded PNG data URLs following `chat/media.ts`; reject traversal/symlinks escaping the run. No secret-bearing persisted DTO.
- Atomically checkpoint collected evidence and completed judgments as the run advances. Saved in-progress runs from a previous process are inspectable as interrupted/incomplete, never successful or silently resumed; retain completed results and explicitly mark unattempted work. Restart inspection requires no provider call. Do not introduce cross-process scheduling.
- Score separately by configuration and development/holdout, including adversarial/insufficient outcomes. Define attempted as started judgments, evaluable as valid model decisions, coverage as non-abstaining decisions/attempted, abstentions/evaluable, infrastructure failures/attempted. Show defective false passes and detection over defective cases with valid decisions, false alarms over clean cases with valid decisions, plus planned/completed counts so infrastructure/missing cases cannot improve apparent qualification. Zero denominators are unavailable. Report exact-verdict mismatches separately across all categories. Critical false passes veto Inspect qualification regardless of averages; incomplete/error runs cannot qualify. Later ladder rungs remain unassessed, never authorization.
- Every category rate must display its valid-decision denominator alongside total planned category cases, infrastructure failures and unattempted counts. Collector failures before judgment remain explicit run/case errors even when attempted judgments is zero; show unavailable rather than zero error rate then. Qualification requires all planned judgments valid and matching their protected verdicts plus no critical false pass; abstention qualifies only where the protected verdict is insufficient-evidence. No failed/missing case can improve qualification.
- Keep tests as test-only injected adjudicators/collectors. Engine, real fixture collection, persistence and deterministic scoring must be implemented fully here. No default fake provider, oracle adjudicator or fallback scoring answer. Record the interface and denominator contract in issue result for 02/03; no new documentation file is needed for this internal seam.

## Do Not

- Do not build a plugin system, database, second browser runtime, generic automation layer or new dependencies.
- Do not leak protected case fields into prompts, infer keyboard support from clicks, replace screenshots with generated images, or claim production safety.
- Do not run checks, real providers or visual proof in this slice. Main owns one integrated verification pass after all issues land.

## Open Questions

### Q1: Which common comparison input should the pilot use?

Type: IMPLEMENTATION
Importance: MEDIUM
Answer Format: SINGLE_SELECT
Options:

- Equal deterministic text observations; screenshots retained as inspectable evidence
- Add an image-capable comparison track
  Comment: Optional. The inspected Jev request supports state/questions, not images.
  Agent Default: Equal deterministic text observations; screenshots retained as inspectable evidence.
  Status: AGENT_DECIDED
  Decision: Use the text-observation track for both providers, retaining real PNG evidence without claiming model vision.

### Q2: Which execution and accounting defaults apply?

Type: IMPLEMENTATION
Importance: MEDIUM
Answer Format: SINGLE_SELECT
Options:

- Sequential bounded execution and explicit denominators as specified above
- Parallel execution with a separate scheduler
  Comment: Optional. Limits are versioned implementation defaults, not new permission grants.
  Agent Default: Sequential bounded execution and explicit denominators as specified above.
  Status: AGENT_DECIDED
  Decision: Use the specified bounds, partial persistence and score denominators; injected adjudication is required and has no production fallback.

## Verify

- Add tests for the exact 24-case category/split matrix, unique neutral IDs and exclusion of protected metadata from serialized adjudicator input, including adversarial content.
- Add browser behavior cases for known-good/defective clipping, labels, true keyboard sequence and save/reload; verify PNGs originate in rendered frames, missing observations remain explicit, and abort/error closes owned resources.
- Add scoring cases for every verdict/category, critical veto, zero denominators, partial/cancelled runs and infrastructure errors distinct from abstention; prove one digest-identical envelope per case across configurations.
- Add persistence round-trip/corruption, invalid ID/path/symlink rejection, size limits, one-active-run, prompt start return, cancellation and disposal tests. Main runs them after integration; test doubles are not AC9 real-provider evidence.
- Test nested/embedded answer-sentinel exclusion, configuration hash changes, checkpointed interrupted-run reload without provider access, and collector failures with zero attempted judgments.
