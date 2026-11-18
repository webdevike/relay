# render

Turns an object description, optionally with a reference image to match, into a studio render and a GLB of a 3D model that an agent builds as a Blender Python script.

## Agents

| id                                    | job                                                                                             | request -> reply                                                                                                                             | default model                                         | triggers                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `prop-render` (`agents/prop-render/`) | `render`: model one object as a Blender script (matching the reference), render it on the stage | `render.requested` `{subject, reference?}` -> `render.completed` `{subject, reference?, image, glb, script, model, attempts, seconds, cost}` | `openrouter/moonshotai/kimi-k3.1-pro`, thinking `low` | `manual`, `onEvent: render.requested`, cron `0 9 * * *` |

- An agent folder (`docs/agent-folders.md`): `AGENT.md` (frontmatter + instructions), `knowledge/script.md`, `bench/`. Request and reply are typed in `schema.ts` and registered by the pack. It is an ask pair, so `agents_ask` takes `{subject, reference?}`.
- `reference`: an absolute image path, a Relay drop `/drops/<id>/<token>` (fetched from the running host: `$RELAY_HOST_URL`, else the port in `$XDG_CONFIG_HOME/relay/serve.json`), or an http(s) URL; PNG, JPEG, WebP or GIF. The model sees it attached (first turn and repair) and is asked to match its silhouette, proportions, part layout, materials, colors and camera angle.
- Prompt: `{{brief}}` from the `render.reference` step (`Model this object: <subject>`, plus the match instruction with a reference). Check: `blender.render`. Harness: `omp` (the default; `harness` may be `codex`, which attaches images with `--image`, or `claude-code`, which cannot attach files).
- Candidate models: kimi-k3.1-pro, gpt-6-sol, gemini-4-carbon, gpt-6-astra, gpt-6.2-astra, gpt-6.2-sol, claude-opus-5-5. `trial: true`.
- The cron input list (one subject per fire) holds seven subjects: brass desk lamp, chipped ceramic mug, vintage rotary telephone, potted succulent, wooden chess rook, retro robot toy, glass perfume bottle with gold cap.
- `knowledge/script.md`: the script contract for Blender 5.2 bpy (one `build()`; imports bpy, bmesh, math, mathutils, random; geometry only; meters, resting on z = 0, centred; named objects and materials; one python block), and how to match a reference: list what the image shows as comments first, keep its proportions and stylization, read colors off the mid-tones, and set `VIEW = {"azimuth": A, "elevation": E}` to the reference's camera angle.

## Tools and adapters

- `adapters/pack.ts`: `blenderPack(layer)`, the `blender` pack (default layer: real Blender). Registers the `render.requested` and `render.completed` schemas, the `render.reference` step and the `blender.render` check.
  - `render.reference`: decodes the request; with a reference, reads the file, drop or URL, checks its magic bytes, writes `reference.<ext>` into the run dir and provides it as `referenceImage` (the agent's `attach`). A missing, unreadable or non-image reference fails the run before any model call with `ReferenceError`.
  - `blender.render`: extracts the fenced python block (or uses the whole reply), writes `build-<attempt>.py` into the run dir, runs it headless (`-b --factory-startup -noaudio --python-exit-code 1 --python stage.py -- <script> <png> <glb>`, binary from `BLENDER`, default `blender`, 3 minute timeout). Provides `image` (`render.png`, 768x768), `glb` (`model.glb`), `script`. A failure gets one repair turn with the script and the traceback; a second failure fails the run with `BlenderError`.
- `adapters/stage.py`: runs inside Blender. Loads the script, calls `build()` if the scene is still empty, deletes any cameras and lights the script made, exports the bare model as GLB (modifiers applied), then adds a matte floor, soft world, three area lights (key, fill, rim), an auto-framed 50mm camera, and renders with `BLENDER_EEVEE` to PNG at exposure -1 (at 0 the lights blew Base Colors out by about a stop, so a reference's colors rendered washed out). A module-level `VIEW` sets the camera's azimuth (0 = the front, from -Y; positive toward +X) and elevation (clamped to -30..85 degrees), and the lights turn with the camera; without it the default view is azimuth about 35, elevation about 23. A malformed `VIEW` is a stage error. Failures print `STAGE_ERROR` plus the traceback.

## Run, bench, test

From `packages/atomic-agents`:

```
bun run smoke
bun src/cli.ts run prop-render render --input '{"subject":"a wooden chess rook"}'
bun src/cli.ts run prop-render render --input '{"subject":"a solar battery","reference":"/abs/path/battery.png"}' --model openai-codex/gpt-6-astra
bun test domains/render
```

- `smoke` runs `prop-render render` with subject `a brass desk lamp`.
- `agents/prop-render/bench/bake.ts`: a blind bake-off. Each arm is `<harness>:<model>`; every case in `bench/cases.json` (`{id, subject, reference?}`; or `--cases <file>`) is rendered by every arm at once through the agent as shipped. `--out` gets one contact sheet per case (the reference on the left when there is one, then the renders shuffled as A, B, C, ...) plus each render's PNG and GLB; `--key` (default `<out>-key/`) gets the key, per-arm cost, seconds, calls and tokens, and every run dir. `--judge <harness>:<model>` has a vision model rate each render against its reference 1-10 (silhouette, proportions, color, overall), in the key only. A run dir with `result.json` (and `score.json`) is reused, so a crashed bake resumes.

```
bun domains/render/agents/prop-render/bench/bake.ts --out <dir> --arms omp:openai-codex/gpt-6-astra,omp:openai-codex/gpt-6.2-astra --cases <file> --judge omp:anthropic/claude-opus-5-5
```

- `test/render.test.ts` runs the shipped agent with a fake Blender and a scripted model: no reference (subject-only prompt, nothing attached), a drop reference (fetched from a stand-in host, saved as `reference.png`, attached, echoed in the reply), and a non-image reference (fails before any model call).
- Real runs need Blender installed (or `BLENDER` set) and a reachable model provider; the `codex` and `claude-code` harnesses need those CLIs signed in.

## Exports (`index.ts`)

- `blenderPack`, `Blender` (the service, for test fakes), `RenderRequested`, `RenderCompleted`. `blenderPack()` is registered in `src/packs.ts`.

## Gotchas

- Needs Blender 5.x: the knowledge file says Principled BSDF has no `Specular` or `Transmission` input, use `Transmission Weight`.
- The stage owns camera, lights, world and render settings; cameras and lights the script creates are deleted before rendering. The agent's only camera input is `VIEW`.
- If the script calls `build()` itself at module level, the stage skips calling it again (it only calls `build()` when the scene is empty). A script with no visible geometry fails with `build() created no visible geometry`.
- Only the first repair is allowed; the traceback sent back is the last 2500 characters after `STAGE_ERROR`.
- A drop reference needs the Relay host running on this machine; drop tokens are the only gate, so `/drops/<id>/<token>` from a chat works as is.
