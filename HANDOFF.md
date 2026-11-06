# HANDOFF: Relay Studio redesign, Direction B (branch eva/studio-redesign, worktree work/relay-studio-redesign)

(The previous file here was the @computer handoff: `git show 6a44c4f4:HANDOFF.md`.)

Isaac approved Direction B (projects rail) on 2026-11-06. Spec = the clickable prototype `work/studio-proto` (src/,
http://127.0.0.1:5390) where it differs from the board `studio-redesign`; design notes in `work/studio-redesign/`.
Build brief shared by every slice: `local://studio-build.md` (copied below under "Brief" when final).

## Rules
No real generation jobs in dev or tests (stubbed backends, fake host, existing files). Never drive the live Relay app
(headless e2e). Desktop deploys allowed (`bun /Users/ike/Eva/.omp/tools/relay-desktop-deploy.ts deploy`). Host: build +
push, then STOP: the install needs Isaac's heads-up via Nova. Phone OTA only after the host is installed. One real smoke
per engine only if Isaac says so.

## Done (committed)
- 3ba8539a wire model: protocol + contract (projects, lineage parent+how, batch/count, favorites, trash + 10 min undo,
  references, SAM segments + spec.mask, `sam` and `crop` backends, `studio.library` / `studio.segments` frames, lineage
  helpers `studioItems/studioLineage/studioVersions/...`).

## In flight (subagents, same worktree, integrator commits)
- HostCore: service/store ops, purge of every copy (store + thumb + ComfyUI output/input + temp) after the undo window,
  machine-wide GPU lock for kontext/comfyui/sam, create count -> N jobs, index v2 migration, tests.
- HostEngines: SAM 2.1 (transformers, `~/.local/share/hades-fit/bin/python`, weights in HF cache) segments + cutout,
  crop runner, masked composite, presets `qwen-edit` (new), relight `direction`, upscale sizes.
- DesktopLibrary: landing (rail, grid, filters, selection, bulk bar, create bar, queue, references, send to chat, add to
  canvas), main plumbing, fake host, e2e/studio.spec.ts.
- DesktopEditor: renderer/studio/editor/* + e2e/studio-editor.spec.ts.
- Phone: apps/mobile Studio.

## Open questions
- Upscale 4x on SeedVR2 3B above 4096 px is unverified (no test generations).
- Qwen Image Edit plain preset quality unverified until Isaac allows one real smoke.

Checkpoint: 2026-11-06 16:30 EST
