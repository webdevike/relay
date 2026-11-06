# HANDOFF: Relay Studio redesign, Direction B (branch eva/studio-redesign, worktree work/relay-studio-redesign)

(The previous file here was the @computer handoff: `git show 6a44c4f4:HANDOFF.md`.)

Isaac approved Direction B (projects rail) on 2026-11-06. Spec = the clickable prototype `work/studio-proto` (src/,
http://127.0.0.1:5390) where it differs from the board `studio-redesign`; design notes in `work/studio-redesign/`.

## Rules
No real generation jobs in dev or tests (stubbed backends, fake host, existing files). Never drive the live Relay app
(headless e2e). Desktop deploys allowed (`bun /Users/ike/Eva/.omp/tools/relay-desktop-deploy.ts deploy`). Host: build +
push, then STOP: the install needs Isaac's heads-up via Nova. Phone OTA only after the host is installed (`pnpm
ota:publish` at the repo root). One real smoke per engine only if Isaac says so.

## What is built (all on main once pushed)
- Wire (packages/protocol + contract mirror): projects, lineage `parent {asset, how}`, `batch` (create `count` 1 to 4 =
  separate queued jobs, consecutive seeds), asset `favorite` / `deletedAt` (trash, 10 min undo), Styles/Characters
  `references` (host copies), SAM 2.1 `segment` op + `studio.segments`, `spec.mask` (segment-scoped edits), backends `sam`
  (cutout) and `crop`, frames `studio.library` / `studio.segments`, lineage helpers (`studioVersions` etc.).
- Host (apps/linux/src/studio): every op; purge after the window deletes EVERY copy (store file + thumb + ComfyUI
  output/studio + its input uploads + LTX `draft-*` temp + segment files + work dir; also on immediate `delete`), test
  `studio trash > deletes every copy once the undo window passes` (test/studio-library.test.ts); machine-wide GPU lock
  `~/.cache/eva-gpu.lock` (gpu-lock.ts, perl flock helper) for Kontext/ComfyUI/SAM and segment runs, MOSS/LTX lock
  themselves; index.json v2 migration; finished jobs never evicted (MAX_STUDIO_JOBS 5000). sam.ts (transformers SAM 2.1
  on CPU in `~/.local/share/hades-fit/bin/python`, `RELAY_STUDIO_SAM_PYTHON`; one real run on an existing image: 12
  objects in 81 s), crop.ts, media.ts compositeMasked.
- Presets (outside the repo, live now in `work/local-higgsfield/presets`): new `qwen-edit` (Qwen-Image-Edit-2509 Q4 GGUF +
  Lightning 4-step), relight `direction` input (9 ids), upscale sizes 1536/2048/2880/3072/4096/6144 (4096+ untested).
- Desktop (apps/desktop/src/renderer/studio): library/* landing (rail, grid of originals, filters, selection + marquee,
  bulk bar, create bar with @ refs, queue indicator, send to chat via composer-fill images, add to canvas via new
  `studio.canvas` invoke), editor/* (strip, compare, segments, tools, recipes.ts, generating overlay). The editor fills
  the Studio pane (Relay's sidebar stays), always dark.
- Phone (apps/mobile): switcher, 2-col grid, long-press select + bulk, editor with swipeable strip + edit bar, create bar.

## Checks (last run 2026-11-06 ~17:05)
- Host: `cd apps/linux && npx vitest run test/studio` 96/96 (studio, studio-library 15, studio-comfyui, studio-runners,
  studio-engines). Full host suite 753/754 earlier (canvas.test 'board file' flaky under load, passes alone).
- Desktop: typecheck 0 errors, `pnpm lint` clean, `pnpm test` 2239/2239, e2e studio, studio-editor, composer,
  composer-images, canvas, computer, at-menu: 20/20 headless. Proof: proof/studio-redesign/*.png.
- Phone: `pnpm test` 808/808; typecheck/lint failures are pre-existing outside Studio. Proof: apps/mobile/proof/studio-redesign/.
- Host app built: `apps/mac-host/build/Relay Host.app` 0.2.81 (build only, no GitHub release). Installed: 0.2.80.
- Desktop DEPLOYED: published bd1c76e6d2 (main), Mini kicked, MBP unreachable (picks it up on its 5-min poll). The first
  deploy attempt failed on 7 timing-flaky unit tests under load; all 2250 pass on a rerun, second deploy went through.

## Next
1. Isaac's heads-up via Nova, then install the host (`./build.sh 0.2.81 --release` publishes host-v0.2.81 which every
   installed copy picks up; or install the built app). Until then the deployed desktop Studio talks to the old host:
   projects/favorites/trash/segments ops are refused, creates make one job.
2. After the host install: phone OTA (`pnpm ota:publish`).
3. Only if Isaac says so: one real smoke per engine (Qwen edit, Kontext, Codex edit, relight, angle, upscale 2x, LTX
   video, cutout, segments, crop, klein combine/character, MOSS, klein create).

## Open questions
- Upscale 4x (4096/6144 short side) on SeedVR2 3B is unverified; Qwen Image Edit plain preset quality unverified.
- Leftovers from before this work (not deleted, needs Isaac's yes): ~96 `relay-*.png` in ComfyUI/input, 4 `draft-*` dirs
  in work/local-video.
- SAM segments take ~80 s on CPU per image (cached after); MPS was not tried.

Checkpoint: 2026-11-06 17:10 EST
