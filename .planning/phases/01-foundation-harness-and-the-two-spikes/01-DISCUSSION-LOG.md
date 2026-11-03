# Phase 1: Foundation, Harness and the Two Spikes - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-10-14
**Phase:** 1-Foundation, Harness and the Two Spikes
**Mode:** --auto (Isaac unavailable). Every question resolved by Claude with the research-recommended option.
**Areas discussed:** Workspace shape, Window composition and browser hosting, Browser extensions and Arc import, Chat streaming spike, Fixtures and data safety, Proof and testing

---

## Workspace shape

| Option | Description | Selected |
|--------|-------------|----------|
| pnpm monorepo with Electron-free packages | `apps/desktop` + `packages/{contract,chat-core,eva-core}`; research-recommended | ✓ |
| Single electron-vite app | Everything under one `src/`; faster to start, harder to unit test pure logic | |

[auto] Workspace — Q: "Monorepo with pure packages or single app?" → Selected: "pnpm monorepo" (recommended default)

## Window composition and browser hosting

| Option | Description | Selected |
|--------|-------------|----------|
| BaseWindow + shell WebContentsView + per-tab child views | Research-recommended; verify Playwright sees the shell view day one, fall back to BrowserWindow | ✓ |
| BrowserWindow + child WebContentsViews | Safer for Playwright, less uniform view model | |
| `<webview>` tag | Deprecated path, poor DevTools, rejected by research | |

[auto] Occlusion — Q: "Hide the view or swap a bitmap under overlays?" → Selected: "Hide via one OverlayStack hook; bitmap later" (recommended default)
[auto] DevTools — Q: "Docked or detached by default?" → Selected: "Detached; lazily re-attach CDP" (recommended default)

## Browser extensions and Arc import

| Option | Description | Selected |
|--------|-------------|----------|
| electron-chrome-extensions + electron-chrome-web-store, Bitwarden from the Web Store | Isaac's recorded decision | ✓ |
| `bw` CLI autofill as the Rust app does | Rejected by Isaac's note (prefer real extensions) | |
| Reuse `.omp/tools/arc-cookies.ts` for Arc logins and insert via `session.cookies.set` | Mirrors the Rust app, read-only use of Eva tooling | ✓ |
| Reimplement Arc cookie decryption in TypeScript | Duplicates an existing tool; Keychain handling risk | |

[auto] Trigger — Q: "Import Arc logins on launch or on a button?" → Selected: "Explicit button only" (recommended default)

## Chat streaming spike

| Option | Description | Selected |
|--------|-------------|----------|
| Resume-only over stdio; Transport interface defined now | Research-recommended; new-chat ADR in Phase 4 | ✓ |
| Also implement new chats via direct omp child | Pre-empts the Phase 4 ADR | |
| Reducer in main with seq batching, renderer mirror | Research-recommended | ✓ |
| Forward raw frames to renderer | Loses state on reload, duplicated per view | |
| virtua first, tanstack fallback | Research reconciliation | ✓ |
| Plain text + code fences in the spike | Markdown is Phase 5 | ✓ |

## Fixtures and data safety

| Option | Description | Selected |
|--------|-------------|----------|
| Fixture Eva root + fake omp + temp config dir by default; live opt-in | Research-recommended | ✓ |
| Run against the real checkout read-only by default | Risk of stray writes and live-session interference | |
| Separate config dir from the Rust app | Research policy; no shared `inbox.jsonl` | ✓ |

## Proof and testing

| Option | Description | Selected |
|--------|-------------|----------|
| Playwright against the built `out/` plus one packaged `.app` smoke | Research-recommended | ✓ |
| Playwright against the Vite dev server | Faster but does not prove the build | |
| `proofShot` composite with capturePage and blank-image check | Required; page.screenshot misses native views | ✓ |

## Claude's Discretion

Directory layout inside `apps/desktop/src`, IPC channel naming, zustand store shapes, Prettier settings, in-app history storage format, the test extension, benchmark fixture generation.

## Deferred Ideas

New-chat transport ADR (Phase 4); OAuth popup handling; bitmap occlusion placeholder; Arc history import (v2); Safari UA synthesis (not planned).
