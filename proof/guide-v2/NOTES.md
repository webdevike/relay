# Guide v2 and image widths: before/after proof

- Baseline: `61a5b2e6` (origin/main, app code untouched; only the spec, `e2e/helpers/fake-relay-host.ts` and `e2e/fixtures/reviews/` were copied in for the run, then removed)
- Head: after shots re-taken at `fa23dd9d` (branch `eva/guide-v2`, after the review fixes); before shots unchanged
- Spec: `apps/desktop/e2e/reviews-guide-proof.spec.ts`, the same file in both phases (`PROOF_PHASE=before|after`; Guide v2 and width assertions run only in `after`)
- Mode: Relay Desktop in remote mode (paired `relay-remote.json`) against `FakeRelayHost`, which answers every `reviews.req` op from `apps/desktop/e2e/fixtures/reviews/answers.json` and serves the fixture PNGs at `/reviews/media/<file>/e2e-token`. No GitHub, Linear, Slack or Claude.
- Clock: `EVAOS_NOW=2026-11-27T18:00:00Z`, renderer clock fixed to the same instant (Playwright `clock.setFixedTime`)
- Window: 1440 x 900, light scheme, hidden window
- Fixture seed: `223aeb3f585c6bb23bba0cf66eaa53a0529c77512162d985f28a78f993d4adfd` = sha256 of the fixture files concatenated in sorted path order (`answers.json`, `media/*.png`) followed by the EVAOS_NOW string
- Fixtures are synthetic: PR `acme/notes-api#42` built from `packages/protocol/fixtures/review-guide.json` (6 files: modified, deleted `src/old.ts`, renamed `src/new-name.ts`, new test, lockfile); its Guide is that fixture's expected v2 Guide (4 sections, callouts, not-covered, follow-ups, checklist). Images are generated drawings. No private data.

Run: `cd apps/desktop && pnpm build && PROOF_PHASE=after pnpm e2e:run e2e/reviews-guide-proof.spec.ts --project=parallel --retries 0 --max-failures 1` (before: the same in the baseline worktree with `PROOF_PHASE=before PROOF_DIR=<pr-c>/proof/guide-v2`).

## Shots

| Shot | Before (61a5b2e6) | After (head) |
|---|---|---|
| `conversation.png` | The body's `<img width="320">` banner fills the whole column (about 890 px): the width is dropped. | The banner is capped at 320 px (`max-width: min(320px, 100%)`); the markdown image without a width keeps its natural size. |
| `conversation-comment.png` | The comment's image (host-rewritten `"w=480"` title) fills the column at 800 px. | The comment's image is 480 px wide, as its author sized it. |
| `guide.png` | v1 Guide: section title, one-line why, a file chip list and each file's full diff. No overview or risk. | v2 Guide: overview card with MEDIUM RISK and its reason; section 1 shows its explanation, Check and Risks lists, and only the selected hunks with callout rows under the lines they explain (`old 5 The old code compared milliseconds to minutes`, `5 Minutes, not milliseconds`). |
| `guide-cleanup.png` | Sections 2 to 4 with file chips and whole-file diffs. | Sections 3 and 4 show the deleted file's hunk (old side) and the rename's hunk, then the test hunk with its Check list. |
| `guide-end.png` | Same as before's cleanup view (v1 has nothing after the last section). | After the last section: Not covered (`pnpm-lock.yaml`, Lockfile bump, View in Diff), Follow-ups and the Review checklist. |
| `diff.png` | Files tab, split diff of all 6 files. | Identical: the Files tab moved to the shared protocol diff parser with no visible change. |

## Assertions (after)

- Guide `data-source="model"`, `data-version="2"`, 4 `review-guide-section`s (4 in before too), the overview and at least one `review-diff-annotation` row visible, callout text shown.
- Body banner: computed `max-width` contains `320px`, rendered width 320 px; comment image: `480px`, 480 px.
- The fake host saw `queue`, `pr` and `guide` ops.

## Visual check (after shots)

No overlaps, clipped text or spacing breaks in the changed screens. One pre-existing defect, the same in before and after and not part of this PR: the Files tab's `deleted` pill on `src/old.ts` (`.eva-rv-pill[data-tone='green']`) paints its text in the same green as its background, so the label is unreadable.
