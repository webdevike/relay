# agent-p4 fixture

A disposable omp agent dir for Phase 4 chat specs. Never point the app at this directory directly:
use `makeChatFixture()` (`apps/desktop/e2e/helpers/chat-fixture.ts`), which copies it to a tmp dir and applies
`mtimes.json` (minutes ago, all older than 1 hour) so ordering is deterministic. Keys are session ids, or
`<id>/<subagent>` for subagent transcripts. Layout: `sessions/-fixture/<ISO>_<id>.jsonl`, `blobs/`, `session-pins.json`.
All images are generated 8x8 PNGs. Everything is synthetic.

| Session id | Title | Used for |
|---|---|---|
| p4-ecard | eCard reports app cleanup | category grouping (eCard) |
| p4-relay | Relay airplay bug | category grouping (Relay) |
| p4-evaos | EvaOS gpui chat list | category grouping (EvaOS) |
| p4-other1..p4-other7 | Grocery list 1..7 | Other group, show more |
| p4-pinned | Pinned planning notes | pins (`session-pins.json`) |
| p4-archived | Old archived chat | archive (`writeChatPrefs` archived_chats) |
| p4-jobs | Background build job | background jobs: `bg_1` running, `bg_2` ended by a delivery |
| p4-subagents | Subagent research | subagents folder: `a` done (`a.md`), `b` running |
| p4-images | Image prompt | user prompt with an inline base64 PNG and a `blob:sha256:` PNG in `blobs/<hash>.png` |
| p4-rename | Rename me | rename via `--mode rpc` short resume |
| p4-writer | Shared writer chat | shared writer, append while open |
