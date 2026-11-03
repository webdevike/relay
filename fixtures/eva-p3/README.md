# eva-p3 fixture Eva root

Template for Phase 3 e2e specs. Never used directly: `makeEvaFixture()` (apps/desktop/e2e/helpers/eva-fixture.ts) copies it to a temp dir and resolves date tokens relative to today. Phase 2 specs keep using `fixtures/eva-root`.

## Token grammar

Resolved in file contents and in path names.

| Token | Value |
|-------|-------|
| `{{day-N}}` / `{{day+N}}` | local YYYY-MM-DD of today minus or plus N days |
| `{{at-N-HH:MM}}` | ISO 8601 UTC string for local date today-N at HH:MM |
| `{{ms-N-HH:MM}}` | epoch milliseconds of the same instant |
| `{{runid-N-HH:MM}}` | local YYYY-MM-DDTHHMMSS (seconds 00) |
| `{{root}}` | absolute temp root |
| `{{session-file}}` | absolute path of fixtures/agent/sessions/-fixture/2026-10-01T09-00-00-000Z_small.jsonl |

## Expected numbers

Today is the test run day.

| Quantity | Value |
|----------|-------|
| workspaces | 7 (6 files plus built-in Eva) |
| open todos | 5 (T3, T7, T10, T12, T11) |
| next todo id | T16 |
| new row lands | after the T11 line |
| updates this week | 4 |
| filter counts | All 7, Active 5 (flo, eva, relay, goodops, bambee), Has Todos 4 (flo, relay, eva, goodops), Quiet 2 (texo, personal) |
| recent two | Eva and Flo |
| jobs listed | 6 (Bad_Name skipped) |
| scheduled jobs | 4 (nightly, broken, script-job, stale-lock) |
| meetings listed | 5 (broken.json skipped) |
| test calls | 1 |
| pending proposals | 3 |
| meetings this week | 2 |
