---
phase: 03-dashboard-workspaces-jobs-habits-and-meetings
reviewed: 2026-10-15T00:00:00Z
depth: standard
files_reviewed: 50
findings:
  critical: 1
  warning: 13
  info: 5
  total: 19
status: issues_found
---

# Phase 3: Code Review Report

**Depth:** standard, 50 source files (persisted by the orchestrator from the reviewer's report).

## Summary

Write path is sound: every checkout write goes through EvaFs with a closed allowlist, symlink-aware containment and per-path queues. Spawning uses argv with `shell: false`, ids and names are regex-validated, detached job runs are never signalled, sender checks and strict zod inputs wrap every handler. No injection or traversal hole found. Real defects: contract output schemas stricter than the readers feeding them, meeting accept can duplicate todos, photo handling gaps, parse edge cases, wasteful reload fan-out.

## Critical Issues

### CR-01: Output schemas reject data the readers legitimately produce

**Files:** `packages/eva-core/src/model/meetings-read.ts:32`, `packages/eva-core/src/model/jobs-read.ts:134`, `packages/eva-core/src/model/jobs.ts:34`, `packages/contract/src/meetings.ts:15`, `packages/contract/src/jobs.ts:13-27`

`handle()` parses outputs with `entry.output.parse` when not packaged (dev, e2e, proof); packaged builds surface the same mismatches as `invalid-input` on follow-up calls. Cases:
- `readMeetings` accepts any non-dot `*.json`; `MeetingSummarySchema.stem` requires `^[A-Za-z0-9][A-Za-z0-9._-]*$`. `Weekly sync.json` or `_x.json` fails `meetings.list` as a whole in dev, and in production the row lists but get/accept/dismiss return `invalid-input`.
- `listJobs` accepts folder names of any length; `JobName` caps at 64.
- Job `description` (first non-blank step line) and `runNote` are capped at 500 in the contract but unbounded in the reader.
- `parseDuration("9999999999d")` passes `validateJob`; `nextDue` exceeds `Number.MAX_SAFE_INTEGER` and fails `z.number().int()` for `nextDueAt`, bricking the Jobs page.
- `lastRunAt: z.number().int()` fails for a fractional `last-run`.
- Proposal and memory `kind` capped at 32 chars, proposal `id` at 300.
- `parseRow` accepts `T<anything>` ids but `OpenTodoSchema.id` requires `^T\d+$`; `- [ ] Tfoo [x] ...` fails `eva.dashboard` and `eva.workspace`.

**Fix:** make readers conform to the contract (skip stems failing the Stem regex; clamp description and runNote to 500; bound durations to about 366 days; `parseRow` returns null unless id matches `^T\d+$`; coerce or floor last-run; clamp kind and id), keeping the two in step.

## Warnings

### WR-01: Accept can add a todo and leave the proposal "proposed", so a retry duplicates the todo
`apps/desktop/src/main/eva/meetings-ipc.ts:123-133`. Todo is appended first, then the status edit runs without `retryOnChange`; if the meeting file changed in between, `changed-on-disk` is thrown after the todo landed. User sees `partial-accept`, reloads, accepts again, second todo. All catch-branch errors collapse into `partial-accept`. **Fix:** pass `{ retryOnChange: true }` to the status edit; treat `not-proposed` after the append as success; consider ordering so the clean-failing step goes first.

### WR-02: `meetings.get` reads an arbitrary absolute `.md` path from the meeting JSON; `openNotes` confines it
`packages/eva-core/src/model/meetings-read.ts:63-70`, `apps/desktop/src/main/eva/meetings-ipc.ts:69`. `readNotes` only checks absolute, `.md`, `lstat().isFile()`. `meetingsOpenNotes` confines to home and the Eva root via realpath. `notes: "/etc/x.md"` has its contents returned to the renderer. **Fix:** one shared resolver: realpath, `isInside` against `[homedir, evaRoot]`, `.md`; use in both.

### WR-03: `habit.openPhoto` takes a renderer path with no extension restriction
`apps/desktop/src/main/eva/habit-ipc.ts:163-166`. Confined to `habitPhotosDir`, but `shell.openPath` launches any regular file there by default handler (`.command`, `.app`, scripts). **Fix:** extend `OpenPathOptions` with `allowExts` and pass `PHOTO_EXTENSIONS`; prefer taking the photo from gate status by id.

### WR-04: Photo token consumed before the gate succeeds and expires mid-break
`habit-ipc.ts:52-57`, `photo-tokens.ts:3,15-19`, `GateOverlay.tsx:90-92`. `takePhotoToken` deletes the token before validation and the CLI run; on error the chip remains but the next Done fails "That photo is no longer available". TTL is 10 minutes but a break can be up to `MAX_MINUTES` (600). **Fix:** peek and consume only after success; extend TTL to break length; have the renderer clear the photo state on `invalid-input`.

### WR-05: `jobs.run` / `spawnDetached` report success even if the process fails to start
`spawn.ts:91-101`, `jobs-ipc.ts:100-110`. ENOENT arrives via the async `error` event; handler returns `{ started: true }` immediately. The "Check that bun is installed" hint is unreachable; no guard against double click. **Fix:** `spawnDetached` returns a promise resolving on `spawn` and rejecting on `error`; return `code: 'spawn-failed'`.

### WR-06: Habit commands not serialized in main
`habit-ipc.ts:92-103`, `habit-store.ts:72-98`. Overlapping `habit.run` calls run two gate processes against the same state file; the renderer `busy` flag clears when the first finishes. **Fix:** promise queue in `createHabitService`; `if (busy) return` at the top of `runHabit`.

### WR-07: Hard array caps in the gate status schema make the gate unreadable as history grows
`packages/contract/src/habits.ts:28-69`, `habit-ipc.ts:44`. `history` max 5000, `tasks` 2000, `habits` 500 are checked in production too; append-only lists eventually exceed them and every poll reports "unreadable status", so the lock overlay cannot render. **Fix:** truncate before validating, or drop `.max()` on read-side schemas.

### WR-08: `eva.changed` triggers a full `reloadAll`, including a habit-gate spawn, for any change
`reload.ts:34`, `watch.ts:42-47`. `areas` is ignored; job runs write continuously under `jobs/.runs` (watched) and meeting accepts create and unlink tmp files, so bursts spawn gate processes. **Fix:** pass `areas` through and key reloaders by area (habits subscribes to none); ignore dotfiles such as `.runs` and `.*.tmp` unless run state is needed (then a dedicated `jobs` area).

### WR-09: "Keep editing" after a stale save silently clobbers external changes to untouched fields
`JobForm.tsx:164-170`, `jobs.ts:128-140`. `keepEditing` adopts fresh disk text as the basis but keeps the old `initial`; `apply` rewrites every field differing from fresh disk and `withSteps` replaces the body. **Fix:** diff against the old initial, apply only user-changed fields, and take steps from fresh text unless edited.

### WR-10: `maxTodoId` can produce `TInfinity` or exponent ids
`todos.ts:82-86`. `Number(m[1])` on unbounded digit runs from prose: 309+ digits is `Infinity`; above 1e21 formats as `T1e+21`; written to the live `memory/todos.md`. **Fix:** only count when `Number.isSafeInteger(n)` (or restrict to `\d{1,9}` if the Rust rule allows).

### WR-11: Job `every`, `max_run` and `keep` accept embedded newlines
`jobs.ts:35`, `jobs-ipc.ts:67-70`, `jobs.ts:136-137`. `parseDuration` uses `\s*` between number and unit so `"5\n\nm"` validates and is written verbatim, corrupting frontmatter. **Fix:** `[ \t]*` in the regex; reject control characters in the three fields.

### WR-12: `evaFs.create` leaves an empty job folder when the write fails
`eva-fs.ts:130-134`. `mkdir` succeeds, `atomicWrite` fails (ENOSPC); the empty `jobs/<name>` stays and every retry returns `already-exists`; `listJobs` skips it so the UI cannot delete it. **Fix:** on failure, non-recursive `rmdir` of the folder this call created; swallow cleanup errors.

### WR-13: Workspace chart uses non-unique tick labels as category keys for `ReferenceArea`
`ActivityChart.tsx:97-114`, `dashboard.ts:161-177`. `x1={first.tick}`/`x2={last.tick}`; ticks are empty except Mondays (30/90D) or repeated single letters (7D), so the "This week" hatch resolves to the first match and is likely mispositioned. **Fix:** `dataKey="date"` on `XAxis` with a `tickFormatter`; `ReferenceArea` on `first.date`/`last.date`; add a render check.

## Info

### IN-01: Dead `patternId`, hardcoded `id="eva-hatch"`
`ActivityChart.tsx:61-62,87`. Fixed pattern id duplicates in the DOM with two charts. **Fix:** use the `useId` value for both pattern id and fill url.

### IN-02: Errors swallowed and misclassified
`watch.ts:64` (empty error handler), `spawn.ts:118-122` (`maxBuffer` reported as `timedOut`; ENOENT gives `code: null`). **Fix:** log watcher errors; distinguish `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and `ENOENT`.

### IN-03: Smaller renderer issues
`JobForm.tsx:38-45` (`parseFieldErrors` accepts a JSON array, so a zod `invalid-input` disables Save with no visible error), `NewTodoModal.tsx:33-36` (`fetchPreview` no try/catch), `meetings-store.ts:103-113,161-166` (`loadMeeting` no ordering guard; `details` never evicted and refetched on every reload). **Fix:** require `!Array.isArray(v)`; try/catch; per-stem request counter; cap the cache.

### IN-04: `EVAOS_NOW` honoured in packaged and live builds
`env.ts:100-103`, `runtime.ts:23-31`. A stray `EVAOS_NOW` shifts the `(added DATE)` written to the real todos file. **Fix:** `now = null` when `isPackaged`.

### IN-05: Smaller cleanups
`habit-ipc.ts:163` (`({ path })` shadows the `path` module), `jobs-store.ts:73-93` (`patch()` duplicates `nextDue`), `todos.ts:104-116` (`appendTodo` appends LF to a CRLF file), `allowlist.ts:37` (`isInside` rejects children whose first segment merely starts with `..`). **Fix:** rename; import `nextDue`; preserve EOL; compare `rel === '..' || rel.startsWith('..' + path.sep)`.

---

_Reviewer: Claude (gsd-code-reviewer), standard depth_
