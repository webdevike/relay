# Test Bench: UI/UX verification

Status: COMPLETE
Review Mode: CHECKPOINTS
Open Question Policy: AGENT_DEFAULTS
Complexity: 8

## For Isaac

### Outcome

Run real, repeatable UI/UX verification trials inside EvaOS and from a CLI, compare agent configurations, and inspect persisted evidence without granting new permissions.

### Proposed Plan

- Produce the 24-case benchmark with isolated real browser evidence, protected answers and persisted scorecards.
- Compare Jev and authenticated omp configurations through one bounded engine and CLI.
- Expose one focused Test Bench page with saved evidence and an Inspect-only qualification ladder.
- Main reviews the complete implementation and real cross-model/browser/UI/restart proof; issue overrides are AUTO.

### Decisions Needed

None for the approved pilot. Isaac explicitly authorized building the previously presented scope and renamed it Test Bench: “Lets just call it test bench and lets get it built.” No shipping or live permission changes authorized.

Budget (normal-formatted accounting replan): 3,050 expected / 3,300 maximum production LOC; 36 expected / 38 maximum touched files; no new dependencies or framework abstractions. Original estimate was 2,200 / 2,550 LOC and 33 expected files. AC1–AC9, permissions and existing approval are unchanged; this corrects underestimated formatted code and necessary integration fixes, not product scope.

## Goal

Deliver the verification-first UI/UX pilot previously proposed: a runnable fixture suite, a reusable verification contract, model comparison, evidence inspection, and trust qualification status. Test Bench refines model/skill/tool configurations by exposing false approvals and missed defects, rather than merely choosing attractive screenshots.

## Acceptance Criteria

- [x] AC1: EvaOS exposes Test Bench in its existing navigation. The focused trial view selects real available models/configurations, starts and cancels bounded runs, shows progress and explicit errors, and opens saved results.
- [x] AC2: A settings-form benchmark contains 24 labeled cases across clean, defective, insufficient-evidence, and adversarial categories, with development/holdout separation. Each case has a specific verification criterion, stable identity, and an expected verdict protected from evaluated model input. Missing evidence is never silently passed.
- [x] AC3: Real browser execution produces screenshots and relevant deterministic observations for UI state, clipping, labels/keyboard behavior, and save persistence as appropriate. No generated image or fabricated metric stands in for rendered or behavioral evidence.
- [x] AC4: At least two real model configurations can run the same suite under equal inputs/limits, with Jev supported alongside the existing agent-model route where reusable. Model decisions follow a validated pass/fail/insufficient-evidence contract. Run errors are distinct from model judgments. No models receive live credentials, unrestricted tools, fixture labels, or write access to the evaluator.
- [x] AC5: Persist run/configuration identities, exact available model identity, skill/rubric/fixture versions, evidence, raw verdicts, timing and supported usage/cost data. Display unsupported cost as unavailable, not zero. Results survive app restart and are inspectable from UI and CLI.
- [x] AC6: Scorecards expose false passes on defective cases, defect detection, false alarms on clean cases, abstention/coverage and denominators. Critical failures cannot be averaged away. A small pilot never claims production safety.
- [x] AC7: The scoped ladder displays Inspect, Repair, Build, Delegate with evidence/qualification status; this verification pilot exercises Inspect only and clearly marks later capabilities unassessed. No automatic live permission promotion or pretend repair/build implementations.
- [x] AC8: A documented CLI uses the same engine and persisted result format as EvaOS, supports running and inspecting comparisons, and exits nonzero for infrastructure or benchmark failure according to its documented contract.
- [x] AC9: Verify real cross-model runs, known-good and defective browser cases, cancellation/error handling, persisted reload, and actual rendered EvaOS screens. Integrate locally without overwriting unrelated work or pushing.

## Constraints

- Product name: Test Bench. Remove Forge/Agent Lab from new product-facing copy; prior research history remains historical.
- All production changes stay in the isolated EvaOS Electron worktree. Keep its existing tokens, Mantine components, typed IPC and filesystem conventions. No new dashboard framework or database.
- Screenshots in work/agent-trust-forge/concept are visual intent, not runnable production code. Preserve their restraint, not their static markup.
- Skill inputs must be versioned and bounded; reuse Isaac's design rules without importing unrelated greenfield page machinery.
- Explicit approval above covers the presented pilot, not new paid services, account changes, system installs, production data, deployments, or expanded autonomy. Credentials remain main/CLI-side and must never be logged or sent to evaluated agents.
- Existing untracked .agents/, .codex/, AGENTS.md in the base checkout are Isaac's; do not alter or commit them.
- Follow EvaOS headless proof convention EVAOS_E2E=1; no focus-stealing or restarting Isaac's working app.
- Skip builds/lint/tests/formatters during implementation slices; run focused verification once integration is complete. Preserve newly required behavior tests, not wiring snapshots.

## Spike

### Relevant Existing Code

- IPC: `packages/contract/src/index.ts: invokeContract/eventContract` merge per-domain Zod contracts; `apps/desktop/src/main/ipc/handle.ts: handle/emit` validates inputs and app-shell origin and returns `Result`. `src/preload/bridge.ts: createEvaBridge` derives its allowlist from these contracts, so no additional preload API is needed. Persisted/model payloads must still be parsed explicitly: handler output validation is skipped in packaged builds.
- Navigation: `packages/shell-core/src/place.ts: FixedPage/FIXED_PAGES/pageFromKey` govern navigation and restored places. `apps/desktop/src/renderer/pages/page-meta.ts: NAV_PAGES` feeds `sidebar/MainNav.tsx: MAIN`; `pages/registry.ts: PAGE_BY_SLUG` selects the page. Add one `test-bench` place, metadata entry and registry component, not another router/sidebar level. `sidebar/icons.ts: ICONS` already offers `IconListCheck`.
- Main composition/storage: `apps/desktop/src/main/index.ts: bootstrap` creates the config store and registers domains; `context.ts: MainContext` is the service seam. `config-store.ts: createConfigStore` provides atomic JSON replacement and strict leaf filenames. `env.ts: resolveEnv` uses `EVAOS_CONFIG_DIR`, otherwise `~/Library/Application Support/EvaOS Electron` in live/packaged mode and a per-process temporary directory in development. `eva/write-guard.ts: installWriteGuard` explicitly permits config/tmp writes while protecting Eva source.
- Models: `apps/desktop/src/main/chat/models.ts: ModelCatalog.list/fetch` obtains authenticated omp `get_available_models` via a no-session RPC child. `chat/live-ipc.ts: catalogFor` caches a catalog but uses Eva root and inherited environment. `packages/chat-core/src/launch.ts: parseModels/ModelInfo` retains exact provider/id, image capability and thinking levels; `foldModels` deliberately drops aliases, so its display name is not an immutable model identity. `ompArgs` supports `--profile` and exact provider/model; `renderer/chat/composer/AccountPicker.tsx` exposes Current/Personal/Work. Existing chat `SessionManager` is interactive, defaults to configured approval (possibly yolo), and must not be the evaluator.
- Provider calls: hub `.omp/tools/lib/selector.mjs: selector` loads small adapters. `selectors/jev.mjs: createSelector/readKey` posts `{model: "jev-latest", state, questions}` to TypeSafe System One with an abort signal and returns answers/usage, reading existing environment or `secrets/jev.env` only in the host. `selectors/openai.mjs: createSelector` demonstrates a tools-free structured chat completion, but requires a separate API key and is not omp OAuth/profile routing. No direct profile-auth completion SDK exists in the inspected Electron code. Do not replace working omp authentication with that adapter.
- Parent-observed executable help (not rerun here): omp supports exact `--model provider/id`, `-p --mode json --no-session --no-tools --no-extensions --no-skills --no-rules --no-lsp --no-title --max-time`, stdin prompts and `@image.png`. This provides the smallest candidate main-agent provider route without extracting credentials. `/Users/ike/.local/bin/omp` is a compiled executable, not readable source.
- Browser: `apps/desktop/src/main/browser/page-control.ts: PageControl.evaluate` wraps Electron CDP `Runtime.evaluate`; `browser-host.ts: BrowserHost.createTab` demonstrates sandboxed, isolated, Node-disabled `WebContentsView`. Its `persist:browser` partition, extension host/history and imported Arc cookies are inappropriate for fixtures. `guest-session.ts: setupGuestSession` supplies permission-denial patterns, but only protects that existing partition.
- Evidence: `apps/desktop/e2e/helpers/proofShot.ts: proofShot` captures native views with `webContents.capturePage().toPNG()` because shell screenshots omit them. `main/chat/media.ts: readBlobImage` demonstrates bounded, strict-token, realpath-confined data-URL delivery; reuse its security pattern, not its omp blob directory. Hub `.omp/tools/ui-lint.mjs: audit` measures real DOM rectangles, text Range clipping and overflow; it is an unexported Playwright CLI, not a library suitable for importing wholesale.
- Runtime/proof: desktop `package.json` has Electron 44.7.2 and `@playwright/test` 1.64.1 as development dependencies; Playwright is proof tooling, not a declared production browser runtime. `main/eva/spawn.ts: buildCommand/childPathFor` resolve argv-based commands and Electron-as-Node fallback; `runCapture` has bounded output/time but closes stdin and has no cancellation signal, so it is not sufficient unchanged for prompt execution. `electron.vite.config.ts` presently builds one main entry. `e2e/fixtures.ts: buildLaunchEnv/launchApp` isolates config and forces `EVAOS_E2E=1` plus `EVAOS_HIDDEN_WINDOW=1`; `window.ts: createMainWindow` uses transparent/click-through `showInactive`. `playwright.config.ts` already runs one worker.

### Recommended Implementation

1. Add a domain contract in `packages/contract/src/test-bench.ts`, merge it in `index.ts`, and keep implementation under `apps/desktop/src/main/test-bench/`. Proposed concrete modules: `fixtures.ts` (versioned cases, protected labels and HTML generator), `browser.ts` (one isolated Chromium fixture runner), `models.ts` (Jev/omp boundary), `engine.ts` (bounded orchestration, scorecards and config persistence), `ipc.ts` (thin handlers), and `cli.ts` (thin executable entry). These are responsibilities, not a plugin architecture; no new workspace package is needed.
2. Define exactly 24 explicit cases: six per clean/defective/insufficient-evidence/adversarial category, with four development and two holdout cases per category (16/8 overall). Category and expected verdict remain host-side; adversarial cases have individually specified expected verdicts, not an automatic failure label. Stable opaque IDs, neutral HTML, criterion and prescribed actions must not encode answers in names/classes/URLs. Keep expected verdict, severity and split out of the evaluated envelope. The shared settings form should have genuinely different cases covering saved/not-saved values, clipping, labels and keyboard reachability, plus missing observations and page-text instruction attacks, not 24 renamed copies.
3. Render the owned form in a fresh in-memory Electron session per case, without preload, Node integration, imported cookies, extensions or external navigation. Use a loopback fixture origin restricted to the owned server route so localStorage persistence can be tested by save then reload; deny all other guest network requests, popups and permissions. Reuse `PageControl.evaluate` for fixed host-authored measurements; use Electron/CDP keyboard input and inspect activeElement rather than declaring `.click()` a keyboard test. Capture real before/after screenshots, viewport, labels, rectangles/clipping, focus sequence and saved/reloaded values as applicable. Keep window lifecycle/background-paint conventions from `window.ts`; destroy owned contents/server/session on completion, error and cancellation. Do not add Chromium/Playwright downloads.
4. Collect each case's evidence once per comparison and reuse its digest-identical bounded decision envelope for every selected configuration. A text-observation track is the supported common denominator: the inspected Jev adapter accepts state/questions, not images. Both routes receive the same criterion, versioned bounded rubric and deterministic observations; screenshots remain inspectable proof. Label this track honestly rather than claiming Jev image analysis. Do not silently give one model screenshots or a richer context than the other. A future image track is unnecessary for this pilot.
5. Jev uses the existing host credential path and observed System One request shape, with choice keys `pass`, `fail`, `insufficient-evidence`. Port the small adapter with explicit Eva root. For omp, the parent's observed safe RPC handshake and real authenticated JSON verdict supersede the earlier print-mode candidate: use a fresh isolated RPC child with no-tools/no-context flags and require empty `dumpTools`, zero messages, exact identity and allowlisted generic system context before sending a prompt. Issue 02 owns the exact gate and bounded parser. Reuse ModelCatalog/parseModels and existing profile authentication; never use interactive SessionManager, permissive approval, copied auth databases or a new auth service.
6. Make tools/context isolation a prerequisite, not a prompt promise: establish that the installed omp disables MCP/task/custom tool injection and parent session context with this invocation; if needed use an explicitly supported local overlay without changing global config. Reject unexpected tool events and mismatched returned model identity as infrastructure failures, but do not mistake post-hoc event rejection for prevention. Retain raw model answer plus validated decision separately; malformed output, provider failure and timeout are run errors, not `insufficient-evidence` judgments. Preserve requested and returned model IDs; when Jev exposes only `jev-latest`, record that alias and “resolved version unavailable,” never invent a revision.
7. One engine owns sequential case/config execution, maximum selected configurations, per-call timeout, total run deadline, bounded input/output, cancellation and progress. Starting returns a run ID promptly. Save partial terminal state after cancellation/error; abort the current fetch/owned child and close browser resources, never affect live chat processes. Keep one active comparison per service. UI invokes `testBench.models/start/cancel/list/get/evidence` and subscribes to `testBench.progress`; CLI calls the same engine directly. Model identity/profile/rubric/limits form a configuration identity; persist fixture, rubric and skill text versions/hashes and evidence digests with timestamps.
8. Store all persistent outputs under `<env.configDir>/test-bench/runs/<generated-run-id>/`, including JSON and PNGs. Use `createConfigStore(runDir)` with leaf filenames and `readText` plus Zod parsing (not silent `readJson` fallback for corrupt results); use bounded owned PNG writes in that directory. Derive history from run directories, not a second mutable index/database. Renderer accepts only validated run/evidence IDs; main resolves inside the run directory and serves a size-bounded PNG data URL following `readBlobImage`. No arbitrary filesystem-path IPC or live Eva writes. Development restart/CLI comparison must use the same explicit stable `EVAOS_CONFIG_DIR`, because default dev config is PID-specific.
9. Score each configuration separately and show development/holdout breakdown. Count false passes/defective denominator, detected defects/defective denominator, false alarms/clean denominator, abstentions/evaluable cases, coverage/attempted cases, and infrastructure failures/attempted cases; show missing and zero denominators as unavailable. Include adjudication on adversarial and insufficient cases explicitly. Record supported usage and cost only, with unsupported values `null`/unavailable, not fabricated zero. List critical false passes prominently with a qualification veto regardless of averages. Inspect status is scoped evidence/completion/critical-failure status, not a statistical safety claim or authorization; Repair/Build/Delegate remain unassessed.
10. Add `renderer/test-bench/TestBenchPage.tsx` and scoped CSS using existing Mantine components and `--eva-*` tokens. One focused trial/results page can select configurations, run/cancel, display progress/errors, browse saved comparisons, show per-model scorecards, select case evidence/raw answers and display the scoped ladder. No separate dashboard or navigation subsystem. Register the fixed place, `NAV_PAGES` entry and `PAGE_BY_SLUG` component.
11. Add a bundled Electron CLI entry through `electron.vite.config.ts` and desktop/root package scripts. Commands `models`, `run`, `list`, `show <id>` use the identical engine/storage schema, with JSON output available. Run the CLI entry in Electron main mode with no shell window, accessory/hidden fixture window only; Electron run-as-node cannot create WebContents. If a Node launcher is used, it must clear `ELECTRON_RUN_AS_NODE` for the Electron worker, not implement another runner. Document exits: 0 completed with no verdict mismatch/critical failure, 1 completed benchmark failure, 2 infrastructure/invalid input, 130 cancelled; infrastructure takes precedence in partial comparisons. `list/show` succeed on valid saved data regardless of the historical run outcome.
12. Add focused behavior tests alongside contracts/engine/browser/providers and an `e2e/test-bench.spec.ts`; update `TRY.md` with commands, credentials-through-existing-routes, limits, score interpretation, paths and proof instructions. Main integration owner runs verification once after all slices: actual Jev plus one authenticated omp provider across the same 24 cases, real clean/defective behavior and screenshots, label/prompt exclusion, cancellation/error cleanup, CLI exit behavior, result reload across restart, navigation and rendered EvaOS proof. Use `EVAOS_E2E=1 EVAOS_HIDDEN_WINDOW=1`, disposable stable config and fixture Eva root; override only the real omp binary/auth routing needed, not all fixture defaults with live mode. Automated doubles do not satisfy real-model AC9.

### Reuse Opportunities

- Reuse Zod contracts, `handle/emit`, derived preload allowlists, place serialization, `NAV_PAGES`, existing scroll container and theme tokens unchanged except additive domain registration.
- Reuse `ModelCatalog` with a safe command/cwd factory and profile-aware instances; preserve exact selected IDs despite friendly-name folding. Reuse `parseModels` rather than inventing a curated fake availability list. Discovery is not proof credentials will succeed; show provider errors explicitly.
- Reuse omp's own provider/profile authentication rather than reading OAuth tokens or adding an SDK. Jev's existing three-choice System One contract naturally matches the verdict union. Persist raw usage fields only when supplied; the OpenAI adapter's `?? 0` normalization is not suitable for benchmark accounting.
- Reuse `PageControl` and Electron's bundled Chromium, not `BrowserHost`'s authenticated guest partition. Adapt only the small DOM Range/geometry measurements relevant to fixture criteria from hub `ui-lint`; its heuristic exclusions (for example “collapsed” content) must not hide deliberately clipped benchmark defects.
- Reuse `createConfigStore` per run directory, token-confined media-delivery pattern, `buildLaunchEnv`, `proofShot` and existing one-worker proof workflow. Copy only bounded design-rule text (hierarchy, spacing, restrained borders, labels/keyboard usability) into a versioned rubric, not the entire design skill or evaluator answers.

### Things We Should NOT Build

- No repair/build/delegate executors, permission changes, autonomous fixes, “promotion” switch, browser account import, new provider login screen or secret vault.
- No parallel agent swarm, task/MCP tools for judged models, external site crawling, model-generated fixture code, editable holdout labels in renderer, benchmark evidence inferred from labels, or arbitrary user code execution.
- No Playwright production dependency, second Chromium runtime, generic browser abstraction, generic benchmark plugin/package system, database, queue broker or separate CLI scoring engine.
- No extra route family or chart framework; no aggregate “trust score” that hides critical false approvals; no claim that text observations are image-model evaluation or that eight holdout cases establish production safety.

### Risks / Unknowns

- **Implementation gate, not new approval:** installed omp help confirms disabling flags (parent evidence), but executable internals and MCP/task suppression were not available as readable source in this spike. Before real adjudication, integration must establish tool/context isolation and actual JSON event/usage/model identity shape. Do not guess a new config schema or proceed with unrestricted chat as fallback. If isolation cannot be established, AC4 is blocked; switching to new auth/services is a HIGH architecture/permission decision.
- **Credential availability:** neither secrets nor live provider calls were inspected/executed. Existing credential locations/routing are evidence, not proof of access. Actual Jev and omp success is AC9 work. Missing access must be reported without adding paid services/accounts or relabeling mock responses as real.
- **Browser paint:** hidden views can capture blank frames (`proofShot` documents this). Use the existing transparent, inactive, non-throttled paint convention and await a real rendered frame; a failed capture is infrastructure failure or deliberately withheld evidence only when the case requires it, never a pass.
- **Runtime distinction:** `EVAOS_E2E=1` alone is not the hidden/accessory toggle in `resolveEnv`; `EVAOS_HIDDEN_WINDOW=1` is also required. CLI browser execution needs Electron main mode, not Node mode. Packaged/development config paths differ, so docs must name the same config directory for UI/CLI reload.
- **Holdout boundary:** labels are protected from evaluated input/tools, not cryptographically secret from the human inspecting this local source/results. Do not claim statistical generalization, tune against holdout answers or send category/severity/split metadata to providers.
- **HIGH new decisions:** none required for the recommended text-observation Inspect pilot with existing accounts and local config storage. Conditional escalation only if implementation requires new paid access, unrestricted tool privileges, a new runtime/auth subsystem, production data or changing the approved scope. Record any such question as HIGH with explicit answer format/options before proceeding; this spike does not grant approval.

### Proposed Atomic Subissues

1. **01: Produce and persist trustworthy settings-form evidence.** No dependency. Own contracts, protected 24-case fixtures, isolated browser collection, bounded lifecycle, JSON/PNG storage and deterministic scoring. Revised expected **1,400 production LOC**, maximum **1,500**, **12 touched files** including tests. Original estimate: 1,000 / 1,150 LOC.
2. **02: Execute isolated real-model comparisons and CLI.** Depends on 01. Own real Jev/omp boundaries, mandatory pre-prompt RPC isolation, exact identities, shared-engine CLI and all TRY.md documentation. Revised expected **800 production LOC**, maximum **900**, **8 touched files** including tests/docs/config. Original estimate: 600 / 700 LOC. No second runner or authentication subsystem.
3. **03: Expose Test Bench and integrate acceptance proof.** Depends on 02. Own thin IPC, existing navigation and focused trial/evidence UI, scoped ladder and integrated behavior/proof cases. Revised expected **850 production LOC**, maximum **900**, **16 touched files** including tests/config. Original estimate: 600 / 700 LOC and 13 files. Main alone runs final actual provider/browser/CLI/UI/restart proof and integrates locally without pushing.

Revised budget: **3,050 expected / 3,300 maximum production LOC**, **36 expected / 38 maximum total touched files**. Test LOC are accounted separately; docs/config count toward non-test production measurement. Zero new dependencies and zero generic framework abstractions; concrete domain modules/interfaces are not a new framework. Historical reviewed estimate was **2,200 / 2,550 LOC**, **33 / 38 files**; the accounting correction and its limits are recorded below.


## Plan Review

Status: APPROVED

### Acceptance Coverage

- AC1 → 01 bounded run/progress/cancel service, 02 real catalog/provider errors, 03 existing navigation and usable saved-result UI.
- AC2 → 01 exact 24-case 16/8 development/holdout matrix, neutral identities, host-only labels, allowlisted envelope and nested answer-sentinel exclusion; 02 tests actual outbound payloads.
- AC3 → 01 isolated rendered PNGs, DOM/Range clipping, actual keyboard events and save/reload observations; 03 main-owned real browser/UI proof.
- AC4 → 01 digest-identical text-observation input/limits, 02 real Jev plus omp, mandatory pre-prompt empty-tool/context/identity gate and strict verdict/error distinction. No credential, evaluator or tool access.
- AC5 → 01 atomic checkpoints, strict JSON reload, interrupted-run honesty and fixture/rubric/skill/config hashes; 02 requested/returned identity and nullable usage/cost; 03 inspectable persisted evidence after restart. Unresolved Jev revision stays unavailable.
- AC6 → 01 per-configuration/split scoring with valid and planned denominators, collector/infrastructure/unattempted counts, zero-denominator unavailable and critical veto; 03 displays stored scores without reinterpretation. Incomplete/errors/mismatches cannot qualify.
- AC7 → 03 Inspect-only scoped qualification; Repair/Build/Delegate unassessed, no permission promotion or safety claim.
- AC8 → 02 Electron-main CLI calls the identical engine/schema/storage; documented commands and exits 0/1/2/130, inspection independent of historical result.
- AC9 → 03 assembles integration cases; main alone proves two actual configurations across 24 cases, real good/defective browser behavior, cancellation/timeout/error cleanup, CLI/UI restart interoperability and rendered EvaOS, then local-only integration. No mock/smoke substitution.

### Simplification

- Retain three responsibility slices, ordered 01 → 02 → 03. Combining them would obscure independently inspectable evidence, provider and user-facing boundaries; splitting storage/scoring/CLI/UI further adds handoffs without acceptance benefit.
- Reuse Electron Chromium, existing provider authentication/catalog, Zod/typed IPC, config-store atomic writes, shell metadata, Mantine/tokens and proof helpers. No database, second browser, scheduler, provider SDK, chart/router framework or plugin layer.
- One shared engine and score interpretation, one text-observation track, one page and one documentation owner. Screenshots prove actual rendering; no claim the text-only providers analyzed images.
- Tightened nested answer exclusion, content-derived configuration identity, interrupted JSON checkpoints, returned Jev identity honesty and pre-judgment failure denominators without expanding product scope.
- Normal-formatted implementation review: the large modules are a concrete page (546 lines), two real provider transports (486), sequential engine (348), explicit 24-case fixtures (323), shared strict schemas (257), isolated browser (197), CLI (183) and confined storage (164). No removable framework, database, duplicate execution engine or new dependency was found. Schema checks at transport/storage boundaries, provider isolation and browser cleanup serve AC3–AC5, not speculative extensibility.
- Considered mapping the seven repeated score metric rows and sharing ladder markup: these are small local presentation reductions, not a safe recovery of the 407 added lines over the original cap. Compressing fixture tuples, JSX or schemas merely manipulates formatted accounting; dropping cases, evidence, gates or denominators weakens acceptance. Do not undertake an architectural rewrite or code golf to meet the mistaken estimate.

### Complexity and Budget

- Score: **8**, not summed issue scores. Browser isolation and behavioral evidence, safe real-provider lifecycle, shared persisted CLI/UI execution and actual cross-model proof exceed 5. Removing these couplings would remove named acceptance criteria; existing runtime/auth/storage reuse is the smaller coherent alternative to new infrastructure.
- Production LOC: **3,050 expected / 3,300 hard cap**. Issue expectations 1,400 + 800 + 850 and maxima 1,500 + 900 + 900 match machine state. Tests remain separate; docs/config remain non-test production measurement. Use normally formatted code and report additions/deletions separately, not netting deletions to conceal growth.
- Files touched: **36 expected / 38 hard cap**, including tests/docs/config; issue expectations 12 + 8 + 16. Two-file headroom is not permission for unrelated work; update ownership lists to actual touched paths.
- New dependencies: **0 maximum**. New generic/framework abstractions: **0 maximum**. Domain schemas, the concrete service and required provider boundary are the specified implementation, not extensibility infrastructure.

### Accounting Replan (2026-10-20)

- Failed assumption: the original 2,200 expected / 2,550 maximum estimate and executors' dense pre-format accounting (parent reported 1,276 added LOC) did not represent required project-style formatting. Parent measurement after formatting reported **2,957 production lines added, 12 deleted, 1,651 test lines added, 33 files**. This is historical measurement supplied by main, not a fresh reviewer check or a final count.
- Revised 3,300 cap leaves 343 added-line headroom against that observation (331 if counting gross additions plus deletions). It covers only normal formatting and observed existing-contract integration fixes, not new features. The 3,050 expected value is a forecast, not a claimed measurement; main must record final formatted accounting and stop/review again if the cap is exceeded.
- Main's observed integration fixes: issue 02 drains stdout/stderr before Electron's immediate exit to avoid a reproduced 65,536-byte truncated CLI result; issue 03 aligns the Node TypeScript library with the existing Electron runtime's Promise.withResolvers and updates incompatible behavior tests. The latter touches three existing files: `apps/desktop/tsconfig.node.json`, `apps/desktop/src/renderer/sidebar/sidebar.test.tsx`, and `packages/eva-core/src/write-scan.test.ts`. Removing copied-navigation/source-text assertions does not waive runtime navigation, storage, IPC or write-guard coverage. Expected files rise from 33 to 36, below the unchanged 38 cap.
- **Acceptance envelope unchanged:** all AC1–AC9, the 24-case matrix, isolated real providers, persisted UI/CLI evidence, Inspect-only ladder and main-owned real verification remain required. Only LOC accounting and existing-contract repair allowances change. No new permissions, dependencies, frameworks or human decisions; no approval or lifecycle field is changed by this review. Prior result counts remain historical pre-format evidence, not current within-cap claims.

### Execution and Approval Boundary

- All issues use **AUTO** overrides of parent CHECKPOINTS for this already explicitly authorized pilot, allowing main to implement and review the complete scope in this turn. No new product choice, permission or autonomy is approved; newly discovered HIGH divergence stops for a human decision.
- Main recorded Isaac's existing explicit build approval from the current user turn after confirming the reviewed plan stays within the previously presented pilot. `humanReview.status` is APPROVED. No additional product scope or permission is inferred.
- No OPEN human feedback or human decisions remain. Review addressed the current implementation-review instructions above; this review is not new human approval. No checks or production edits were performed by the reviewer.

## Human Feedback

Status: CLEAR

No open feedback.

## Parent Completion

### Status
COMPLETE

### Acceptance Criteria
- PASS AC1: Actual EvaOS navigation, exact model selection, Run comparison and Cancel run driven through the browser; saved cancellation showed 0/48 complete and no qualification.
- PASS AC2: 24 explicit cases, six per category, 16 development/eight holdout. Protected labels excluded by validated public envelopes and outbound-payload regressions.
- PASS AC3: Live Electron evidence captured clean/defective clipping, associated labels, actual keyboard focus and save/reload persistence. Native PNGs visually inspected.
- PASS AC4: Run `babc3bbe-397a-45b3-8327-6b1b150f44d2` completed all 24 cases for Jev 1.13 and GPT-5.6 Luna: 48 valid decisions, no infrastructure errors. Empty-tools/zero-history/exact-model/context gate verified before inference.
- PASS AC5: Stored JSON/PNGs reopened through CLI, offline UI, restart, and the installed package. Version/hash/identity/usage fields persisted; unsupported cost remains unavailable.
- PASS AC6: Jev matched 22/24 and GPT matched 24/24; both had zero false passes on six defective cases. Mismatches prevent qualification and no average hides critical failures. These are fixture outcomes, not production-safety estimates.
- PASS AC7: Installed UI displays Inspect results and Repair/Build/Delegate as Unassessed. No permission changes.
- PASS AC8: Shared-engine CLI discovery returned 75 model entries. Completed mismatch run returned 1 with valid 88,597-byte JSON; timeout returned 2; terminal cancellation returned 130 and persisted cancelled state; saved show returned 0.
- PASS AC9: Typecheck, 1,183 unit tests and three Electron scenarios passed. Actual UI, browser cases, error/cancel paths and installed package verified. Installed at `~/Applications/EvaOS Electron.app`; no working session restarted or remote push performed.

### Planned Complexity
- Score: 8
- Original production estimate: 2,200 / 2,550 hard cap.
- Documented normal-format accounting replan: 3,050 / 3,300 hard cap, unchanged acceptance.
- Files: 36 expected / 38 hard cap.

### Actual Complexity
- Production LOC added: 3018
- Production LOC deleted: 13
- Net LOC: 3005
- Test LOC added: 1670
- Test LOC deleted: 85
- Files touched: 38
- Dependencies added: 0
- Framework abstractions added: 0

### Subissues
- Planned: 3
- Completed: 3
- Added: none
- Scope changes: none. Existing file headroom covered tab naming and the terminal signal launcher.

### Verification
- `pnpm typecheck` — PASS.
- Full Vitest JSON report — 1,183 passed, zero failed, two native-browser tests skipped under Node. Their actual behaviors were independently exercised through live Electron benchmark runs, not counted as unit passes.
- Focused ESLint — PASS.
- `TEST_BENCH_PROOF_CONFIG=... pnpm exec playwright test e2e/test-bench.spec.ts` — PASS, three scenarios including native saved-data restart and live startup ordering.
- `pnpm -C apps/desktop package` — PASS, local unsigned package.
- Installed app loaded the real saved scorecard with zero observed page errors after the startup fix.
- Real CLI output/cancellation regressions: fixed immediate-exit JSON truncation and native SIGINT startup crash; verified full JSON and exit 130 through the terminal launcher.
- Durable screenshots and unit JSON: Eva hub `work/agent-trust-forge/delivered/`.

### Simplification
- Reused Electron, existing authentication, shared engine/CLI/UI storage and typed IPC. No new database, browser runtime, service, dependency or dashboard framework.
- Removed copied-navigation/source-regex assertions; retained runtime boundary and user-behavior regressions.
- Deferred UI details behind disclosure rather than removing evidence.

### Final Result
The approved Inspect pilot is implemented and installed within the reviewed accounting envelope. Later capability levels remain explicitly unassessed, not stub executors or granted autonomy.
