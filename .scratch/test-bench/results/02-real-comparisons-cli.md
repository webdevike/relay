# Result: Execute isolated real-model comparisons and CLI

Status: COMPLETE

## Implemented
- Real Jev System One and authenticated omp RPC adapters with bounded output, strict verdict parsing, identity and usage metadata.
- Pre-prompt empty-tool, zero-history, exact-model and known-context gates; no workspace/private context or unrestricted tools.
- One engine for UI and CLI, with models/run/list/show, persisted results and documented 0/1/2/130 exits.
- Node launcher forwards cancellation over stdin to avoid interrupting Chromium native startup. Output drains before Electron exits.

## Why This Approach
Reuses existing authentication, parseModels, LineFramer and command construction. No new provider SDK, account, service or dependency. Fresh processes isolate model judgments, while host-only labels never enter outbound payloads.

## Reused
- omp provider/profile routing and existing host Jev credentials.
- Shared engine/storage/scoring from issue 01.
- Existing Electron build pipeline, with one additional main entry and a small terminal launcher.

## Actual Complexity
- Production LOC added: 804
- Production LOC deleted: 10
- Test LOC added: 594
- Files touched: 9

## Budget
- Expected production LOC: 800
- Maximum production LOC: 900
- Actual production LOC added: 804
- Actual files: 9, including the necessary signal-forwarding launcher.
- Original dense-line estimate superseded by parent format-accounting replan; no acceptance expansion.

## Review Callouts
- Jev pinned stable/preview IDs, real catalog discovery, unavailable identity/cost represented as null.
- The versioned omp system-context gate fails closed on an upstream contract change.
- Cost is provider-reported metadata when available, not an independent billing guarantee.

## Open Questions Resolved
- Use verified no-tools RPC preflight rather than interactive SessionManager.
- Reuse parseModels/LineFramer directly because existing ModelCatalog folds identities and lacks owned-child cancellation.
- Preserve absent returned identity instead of fabricating it.

## Verification
- Provider/CLI focused tests: 46 passed; final complete Vitest suite: 1183 passed, zero failures.
- Live model discovery returned 75 entries including pinned Jev versions and GPT-5.6 Luna.
- Full real Jev + omp suite: 48 valid judgments, saved and reloaded through CLI and UI.
- Found and fixed immediate Electron exit truncating JSON at 65536 bytes. After fix, full 88597-byte JSON parsed and benchmark mismatch returned exit 1.
- Real judgment timeout returned exit 2 with timeout errors and no qualification.
- Found native Chromium SIGINT startup crash; terminal wrapper now cancels through stdin. Live early Ctrl-C test returned exit 130, saved cancelled state, no qualification.
- CLI show returned exit 0 and parsed a 92680-byte saved comparison without provider access.
- Build and local unsigned package passed.
