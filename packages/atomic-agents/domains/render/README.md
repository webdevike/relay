# render

Turns a one-line object description into a studio render and a GLB of a 3D model that an agent builds as a Blender Python script.

## Agents

| id                                 | job                                                                    | input -> output event                                                                                                | default model                                         | triggers                                                |
| ---------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `prop-render` (`prop-render.json`) | `render`: model one object as a Blender script, render it on the stage | `render.requested` `{subject}` -> `render.completed` `{subject, model, image, glb, script, attempts, seconds, cost}` | `openrouter/moonshotai/kimi-k3.1-pro`, thinking `low` | `manual`, `onEvent: render.requested`, cron `0 9 * * *` |

- Prompt: `Model this object: {{subject}}`. Check: `blender.render`. Output: `render.completed`. Harness: `omp` (the default; `agent.harness` may be `codex` or `claude-code`, same prompt, knowledge and check).
- Candidate models: `openrouter/moonshotai/kimi-k3.1-pro`, `openai-codex/gpt-6-sol`, `openrouter/google/gemini-4-carbon`, `openai-codex/gpt-6-astra`, `anthropic/claude-opus-5-5`.
- The cron input list (one subject per fire) holds seven subjects: brass desk lamp, chipped ceramic mug, vintage rotary telephone, potted succulent, wooden chess rook, retro robot toy, glass perfume bottle with gold cap.
- Knowledge file `prop-render.knowledge.md`: the script contract for Blender 5.2 bpy. Exactly one `build()` function; allowed imports bpy, bmesh, math, mathutils, random; geometry only (no cameras, lights, world, render settings, file or network I/O); meters, resting on z = 0, centred; named objects and materials; reply is one python block.

## Tools and adapters

- `adapters/pack.ts`: the `blender` pack. Provides the `Blender` service and the `blender.render` check.
  - Spawns the Blender binary headless: `-b --factory-startup -noaudio --python-exit-code 1 --python stage.py -- <script> <png> <glb>`.
  - Binary comes from env var `BLENDER` (default `blender` on PATH). Timeout 3 minutes. No secrets are read.
  - The check extracts the fenced python block (or uses the whole reply), writes `build-<attempt>.py` into the run dir, and runs it. Provides `image` (`render.png`, 768x768), `glb` (`model.glb`), `script`.
  - On failure the agent gets one repair turn with its script and the Blender traceback; a second failure fails the run with `BlenderError`.
- `adapters/stage.py`: runs inside Blender. Loads the script, calls `build()` if the scene is still empty, deletes any cameras and lights the script made, exports the bare model as GLB (modifiers applied), then adds a matte floor, soft world, three area lights (key, fill, rim), an auto-framed 50mm camera, and renders with `BLENDER_EEVEE` to PNG. Failures print `STAGE_ERROR` plus the traceback.

## Run, bench, test

From `packages/atomic-agents`:

```
bun run smoke
bun src/cli.ts run prop-render render --input '{"subject":"a wooden chess rook"}'
bun src/cli.ts run prop-render render --input '{"subject":"a retro robot toy"}' --model anthropic/claude-opus-5-5
bun run typecheck
bun test
```

- `smoke` runs `prop-render render` with subject `a brass desk lamp`.
- `bench/bake.ts`: a blind bake-off. Each arm is `<harness>:<model>`; every subject in `bench/cases.json` (Isaac's world objects: solar battery, sun lamp, drop pod, robot minion; or `--cases <file>`) is rendered by every arm at once through the agent as shipped. `--out` gets one contact sheet per subject (renders shuffled as A, B, C, ...) plus each render's PNG and GLB; `--key` (default `<out>-key/`) gets the key, per-arm cost, seconds, calls and tokens, and every run dir. A run dir with `result.json` is reused, so a crashed bake resumes.

```
bun domains/render/bench/bake.ts --out <dir> --arms omp:openai-codex/gpt-6-astra,codex:openai-codex/gpt-6-astra,omp:anthropic/claude-opus-5-5,claude-code:anthropic/claude-opus-5-5
```

- No `test/` directory: `test/agent.test.ts` expects `blender.render` in the registered check list, `test/runtime.test.ts` uses the `prop-render` id in journal fixtures, and `test/harnesses.test.ts` covers the harness adapters.
- Real runs need Blender installed (or `BLENDER` set) and a reachable model provider; the `codex` and `claude-code` harnesses need those CLIs signed in.

## Exports (`index.ts`)

- `blender`: the pack (service layer plus `blender.render` check), registered in `src/packs.ts`.

## Gotchas

- Needs Blender 5.x: the knowledge file says Principled BSDF has no `Specular` or `Transmission` input, use `Transmission Weight`.
- The stage owns camera, lights, world and render settings; cameras and lights the script creates are deleted before rendering.
- If the script calls `build()` itself at module level, the stage skips calling it again (it only calls `build()` when the scene is empty). A script with no visible geometry fails with `build() created no visible geometry`.
- Only the first repair is allowed; the traceback sent back is the last 2500 characters after `STAGE_ERROR`.
