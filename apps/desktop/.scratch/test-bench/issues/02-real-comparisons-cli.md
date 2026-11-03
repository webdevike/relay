# Execute isolated real-model comparisons and CLI

Status: COMPLETE
Review Mode: AUTO
Depends on: 01
Expected production LOC: 800
Maximum production LOC: 900
Expected files touched: 9

Budget replan (2026-10-20): original 600 expected / 700 maximum underestimated normal project formatting. Revised 800 / 900 includes existing TRY.md/config accounting and the observed CLI stdout/stderr drain fix before immediate Electron exit (a real result truncated at 65,536 bytes). No second runner or new scope. Historical result counts are pre-format; main records final formatted measurement under the parent 3,300 LOC / 38-file cap.

Main verification complete: provider/CLI tests, real full-suite comparisons, JSON output above 64 KiB, exit 1 for mismatches, exit 2 for timeout, exit 130 for cancellation, and offline saved-result inspection. A small Node terminal launcher uses the parent file headroom to forward cancellation safely; it calls the same engine, not a second runner.

## For Isaac

- Outcome: Jev and existing authenticated omp models judge the same evidence from a documented CLI.
- Why it matters: Real comparisons need verified isolation, equal inputs and truthful identity/cost reporting.
- Proof: A saved cross-model comparison is inspectable, cancels cleanly and returns documented exit codes.

## Why

Covers AC4, AC8, provider portions of AC5/AC6 and cancellation/error portions of AC1. Consume issue 01's completed engine and injectable adjudicator rather than adding another runner. Before implementation, read its exported schemas/interface and result; preserve the fixed input/result/service contracts for issue 03.

## Implement

- Own exactly `apps/desktop/src/main/test-bench/models.ts`, `apps/desktop/src/main/test-bench/cli.ts`, `apps/desktop/electron.vite.config.ts`, `apps/desktop/package.json`, root `package.json`, `TRY.md`, and `apps/desktop/src/main/test-bench/{models,cli}.test.ts`. Documentation additions count toward the revised 900 production LOC maximum. Do not edit issue 01 engine/contracts; coordinate any necessary correction with its owner rather than introducing parallel DTOs.
- Export a provider factory implementing `Adjudicator.models(signal)` and `judge(config, publicEnvelope, signal)` from 01. Factory accepts explicit Eva root and resolved host command/profile options, never secrets in renderer DTOs. Catalog uses existing `ModelCatalog`, `parseModels`, `buildCommand`, `LineFramer` and safe profile-specific command/cwd factories. Preserve exact provider/id rather than treating friendly folded labels as immutable identity. Availability is real catalog/access information, not a curated model list or guarantee a credential will succeed.
- Implement Jev with existing host environment or `<evaRoot>/secrets/jev.env` credential path and observed System One `{model:'jev-latest',state,questions}` request/abort behavior. Port only the small adapter, do not import the live hub. Map three choice keys to validated verdicts. Store requested alias and resolved version unavailable when response supplies no exact revision. Never invent usage, cost or resolved model version.
- Implement omp as one owned bounded RPC child per judgment in fresh temporary cwd outside Eva ancestry. Reuse its own existing authentication/profile routing; sanitize inherited OMP_/PI_/EVAOS_ context overrides while preserving only required existing auth routing. Use fixed `--mode rpc --no-session --no-tools --no-extensions --no-skills --no-rules --no-lsp --no-title --system-prompt` and selected exact provider/model/profile. No print-mode assumption: RPC permits a pre-prompt isolation handshake. Bound startup, line/output sizes, total call time and cancellation; abort/terminate only owned processes and remove owned temporary data.
- Mandatory gate BEFORE sending any evaluated prompt: request `get_state`, require `data.dumpTools` exactly empty, `messageCount` zero, exact selected `model.provider/id`, and bounded `systemPrompt` containing only the fixed evaluator prompt and recognized generic workstation/memory boilerplate. Reject actual memories/mental models, parent/session/workspace context or unrecognized injected context. Inspect/redact locally; do not persist full startup/system state or log credentials. Missing/unknown fields fail closed. Empty tools are a runtime capability assertion, not proof supplied by model refusal. Reject unexpected tool execution events as infrastructure failure as additional defense, never substitute that post-hoc rejection for the preflight.
- Parent evidence (2026-10-20): installed omp `get_state` returned empty dumpTools, zero messages, exact identity and generic-only context in the isolated invocation; `get_active_tools` is unsupported. Parent real smoke on `openai-codex/gpt-5.6-luna` returned assistant JSON through `message_end.message.content[{type:'text',text}]`, exact provider/model, usage input/output/cacheRead/cacheWrite/totalTokens and cost.total, stopReason=stop; terminal `agent_end` has messages/isTerminal/yielded. Some startup `extension_ui_request` events appeared despite disabling flags: do not service them, do not treat their existence as tools, and never relax the gate. These observations establish the route, not AC9 suite completion; repeat gate in every production child.
- Parse actual bounded assistant text and validated decision separately from lifecycle events; require correct returned identity and terminal completion. Malformed JSON/verdict, mismatched model, provider/auth failure, timeout, unsafe state and unexpected tool event are infrastructure errors, not model abstentions. Persist only bounded raw answer and allowlisted identity/usage/timing metadata; omit full `providerPayload`, `credentialId` and secret-bearing envelopes. Preserve absent usage/cost as null.
- Both providers consume the same immutable text-observation envelope/digest and engine limits. Screenshots are evidence for humans, not silently attached to only one model. No labels/split/severity or fixture source in provider input; no provider access to evaluator files or live tools.
- Transport wrapping may differ, but criterion, rubric/skill content, observations and limits must remain identical; only validated envelope fields enter either request. Test actual outbound serialized bodies/prompts for answer sentinels and secrets. Preserve returned Jev identity when supplied and reject conflicting identity; when absent, record unavailable rather than substituting the requested alias as returned identity.
- Bundle an Electron-main CLI entry (no app shell window) through existing electron-vite configuration and root/desktop scripts. `models`, `run`, `list`, `show <id>` call the identical engine/store, with machine-readable JSON output and progress on stderr. Clear `ELECTRON_RUN_AS_NODE` when launching Electron; fixture capture needs Electron main, not Node mode. Follow accessory/hidden/inactive window conventions and dispose on exit/SIGINT.
- Document precise flags/examples in TRY.md for selecting at least Jev plus one available omp configuration, profile, shared stable `EVAOS_CONFIG_DIR`, versions/limits, text-only comparison meaning, existing credential routes, score denominators/critical veto, storage/evidence paths, UI reload and focused proof. Exit 0 for complete benchmark without verdict mismatch/critical failure, 1 completed benchmark failure, 2 infrastructure/invalid input (takes precedence for partial errors), 130 cancellation. `list/show` return success for valid persisted data independent of historical verdict outcome. No second CLI scoring algorithm.

## Do Not

- Do not use interactive SessionManager, yolo approval, copied OAuth databases, a new provider SDK/auth service, global config changes or prompt-only sandbox claims.
- Do not bypass failed isolation, fabricate a successful model, expose credentials or add repair/build capabilities.
- Do not run validation suites or real provider calls in this slice; main owns final integrated proof.

## Open Questions

### Q3: Which existing omp invocation should adjudicate?

Type: IMPLEMENTATION
Importance: MEDIUM
Answer Format: SINGLE_SELECT
Options:

- Fresh bounded RPC child with mandatory get_state gate before prompt
- Print-mode child without pre-prompt state handshake
  Comment: Optional. Parent observed the RPC state contract and one successful authenticated call; this supersedes the spike's print-mode candidate.
  Agent Default: Fresh bounded RPC child with mandatory get_state gate before prompt.
  Status: AGENT_DECIDED
  Decision: Use RPC and reject unsafe/unrecognized state before inference. No new auth or architectural permission is needed.

### Q4: How should CLI and documentation reuse the engine?

Type: IMPLEMENTATION
Importance: LOW
Answer Format: SINGLE_SELECT
Options:

- Bundled Electron-main CLI using the same service and existing TRY.md
- Separate Node/browser runner and separate CLI guide
  Comment: Optional. Electron is already the runtime; docs count as production under measurement.
  Agent Default: Bundled Electron-main CLI using the same service and existing TRY.md.
  Status: AGENT_DECIDED
  Decision: Keep one engine/schema and one documentation owner here, including later UI/proof instructions.

## Implementation Handoff

- Implementation is delivered in the eight approved files; see `../results/02-real-comparisons-cli.md`.
- Verification gate only: focused tests/build/provider calls are explicitly prohibited in this slice and deferred to main. No failed test or missing implementation is claimed; do not mark COMPLETE until main records passing integrated verification.
- Parent approved exact-ID `parseModels`/`LineFramer` reuse in the shared bounded RPC lifecycle instead of ModelCatalog's folding/unabortable child. No unrelated catalog changes.
- Parent made returned identity nullable in issue 01; supplied pinned identity must still match, absent identity/version remains null. Typed Jev probabilities stay in bounded raw answers.
- Official docs confirmed pinned stable `jev-1.13.0` and preview `jev-1.14.0`; account discovery remains required.
- Historical pre-format gross production change: 412 LOC against the original 700 maximum; tests 285 LOC; eight production/test paths. This is not final formatted accounting. Revised budget above supersedes that cap; no dependencies added.

## Verify

- Add transport tests proving no prompt is sent before safe state; reject nonempty tools, prior messages, context injection, unknown handshake fields, identity mismatch and unsafe profile context. Cover startup extension UI noise without enabling interaction.
- Add Jev/omp payload and parser tests for equal envelope/digest, protected-field and credential exclusion, exact identity, bounded answer, absent usage/cost, malformed verdict, HTTP/auth failure, timeout, unexpected tool event, cancellation and owned-child cleanup.
- Add CLI cases covering all exit codes and precedence, JSON output, corrupt/missing IDs, shared config directory and historical failed-run inspection. Use injected doubles only in tests.
- Main later runs real Jev plus available authenticated omp across the same 24-case suite, retaining gate summaries and bounded actual answers; verifies CLI/UI persisted interoperability, error/cancellation and no leaked context/tools. A smoke call is not the full-suite proof.
