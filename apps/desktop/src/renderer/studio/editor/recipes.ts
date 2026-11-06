// The editor's actions as `create` ops. Every action makes one job from the CURRENT version: its parent is that
// version, its project is that version's project, and it asks for one image. Pure: (version, backends, inputs) in,
// the op (or why it cannot run) out.
import {
  STUDIO_ASPECTS,
  studioRemixSpec,
  studioResolutions,
  studioSeconds,
  type StudioAspect,
  type StudioBackend,
  type StudioBackendId,
  type StudioHow,
  type StudioItem,
  type StudioParent,
  type StudioSpec,
} from '@evaos/contract'

/** One `create` as the editor sends it. */
export interface CreateOp {
  spec: StudioSpec
  count?: number
  project?: string
  parent?: StudioParent
}

/** An op to send, or one line saying why this action cannot run now. */
export type Recipe = { ok: true; op: CreateOp } | { ok: false; problem: string }

export type EditEngine = 'qwen' | 'kontext' | 'codex'

/** The describe-your-edit engines, default first, each with where it runs. */
export const EDIT_ENGINES: ReadonlyArray<{ id: EditEngine; label: string; where: string }> = [
  { id: 'qwen', label: 'Qwen Image Edit', where: 'local' },
  { id: 'kontext', label: 'FLUX Kontext', where: 'local' },
  { id: 'codex', label: 'Codex edit', where: 'ChatGPT' },
]

const ENGINE_TARGET: Record<EditEngine, { backend: StudioBackendId; model?: string }> = {
  qwen: { backend: 'comfyui', model: 'qwen-edit' },
  kontext: { backend: 'kontext' },
  codex: { backend: 'codex-edit' },
}

/** Relight's light directions, the 3x3 picker read row by row. */
export const RELIGHT_DIRECTIONS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'front',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const
export type RelightDirection = (typeof RELIGHT_DIRECTIONS)[number]

/** New angle's choices: the picker's label and the angles preset's option id. */
export const ANGLES = [
  { id: 'left45', label: 'Left' },
  { id: 'right45', label: 'Right' },
  { id: 'top', label: 'Top' },
  { id: 'close', label: 'Close' },
] as const
export type AngleId = (typeof ANGLES)[number]['id']

export const UPSCALE_FACTORS = [2, 4] as const
export type UpscaleFactor = (typeof UPSCALE_FACTORS)[number]

export const VIDEO_SECONDS = [4, 8] as const

export const DEFAULT_RELIGHT_PROMPT = 'soft natural light'
export const DEFAULT_ANGLE_PROMPT = 'same scene'
export const DEFAULT_VIDEO_PROMPT = 'Subtle natural motion'

/** A crop in fractions of the image: left, top, width, height. */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

/** The wire aspect nearest to an image's shape. */
export function closestAspect(width: number, height: number): StudioAspect {
  const ratio = Math.log(width / height)
  let best: StudioAspect = '1:1'
  let gap = Infinity
  for (const aspect of STUDIO_ASPECTS) {
    const [w, h] = aspect.split(':').map(Number) as [number, number]
    const d = Math.abs(ratio - Math.log(w / h))
    if (d < gap) {
      gap = d
      best = aspect
    }
  }
  return best
}

/** The upscale preset's short-side choice for `factor`: the smallest at least that big, else the largest. */
export function upscaleSize(
  backend: StudioBackend,
  width: number,
  height: number,
  factor: number,
): string | undefined {
  const input = backend.models
    ?.find((m) => m.id === 'upscale')
    ?.inputs?.find((i) => i.id === 'size' && i.kind === 'choice')
  if (input?.kind !== 'choice') return undefined
  const sizes = input.options
    .map((o) => ({ id: o.id, px: Number(o.id) }))
    .filter((o) => Number.isFinite(o.px))
    .sort((a, b) => a.px - b.px)
  const want = Math.min(width, height) * factor
  return (sizes.find((s) => s.px >= want) ?? sizes.at(-1))?.id
}

interface Build {
  backend: StudioBackendId
  model?: string
  mode?: StudioSpec['mode']
  prompt: string
  how: StudioHow
  refs?: string[]
  params?: Record<string, string | number>
  mask?: string
  frames?: StudioSpec['frames']
  seconds?: number
}

/** The op for `b` on `cur`, checked against what the host lists. */
function build(cur: StudioItem, backends: readonly StudioBackend[], b: Build): Recipe {
  const backend = backends.find((x) => x.id === b.backend)
  if (!backend) return { ok: false, problem: 'Not on this host' }
  if (!backend.available) return { ok: false, problem: backend.reason ?? `${backend.label} is off` }
  const model = b.model === undefined ? undefined : backend.models?.find((m) => m.id === b.model)
  if (b.model !== undefined && !model) return { ok: false, problem: `${b.model} is not installed` }
  const aspect = closestAspect(cur.asset.width, cur.asset.height)
  const resolution = studioResolutions(backend, aspect, b.model)[0]?.id
  if (!resolution)
    return { ok: false, problem: `${model?.name ?? backend.label} has no ${aspect} size` }
  if (b.seconds !== undefined && !studioSeconds(backend, b.model).includes(b.seconds)) {
    return { ok: false, problem: `${backend.label} does not make ${b.seconds} s videos` }
  }
  const spec: StudioSpec = {
    mode: b.mode ?? 'image',
    backend: b.backend,
    prompt: b.prompt.trim(),
    aspect,
    resolution,
    ...(b.model !== undefined && { model: b.model }),
    ...(b.refs && { refs: b.refs }),
    ...(b.params && { params: b.params }),
    ...(b.mask !== undefined && { mask: b.mask }),
    ...(b.frames && { frames: b.frames }),
    ...(b.seconds !== undefined && { seconds: b.seconds }),
  }
  return { ok: true, op: withLineage(cur, spec, b.how) }
}

function withLineage(cur: StudioItem, spec: StudioSpec, how: StudioHow): CreateOp {
  return {
    spec,
    count: 1,
    ...(cur.job.project !== undefined && { project: cur.job.project }),
    parent: { asset: cur.asset.id, how },
  }
}

const typed = (prompt: string | undefined, fallback: string): string =>
  prompt?.trim() ? prompt.trim() : fallback

/** Describe your edit: the engine edits the current version, inside the segment `mask` when one is picked. */
export function editRecipe(
  cur: StudioItem,
  backends: readonly StudioBackend[],
  input: { engine: EditEngine; prompt: string; mask?: string },
): Recipe {
  if (!input.prompt.trim()) return { ok: false, problem: 'Describe the edit' }
  return build(cur, backends, {
    ...ENGINE_TARGET[input.engine],
    prompt: input.prompt,
    refs: [cur.asset.id],
    how: 'edit',
    ...(input.mask !== undefined && { mask: input.mask }),
  })
}

/** An edit with an @ image or saved reference: FLUX.2 klein combines the current version with one more. */
export function combineRecipe(
  cur: StudioItem,
  backends: readonly StudioBackend[],
  input: { prompt: string; refs: readonly string[] },
): Recipe {
  const extra = input.refs.find((id) => id !== cur.asset.id)
  if (extra === undefined) return { ok: false, problem: 'Pick an image with @' }
  if (!input.prompt.trim()) return { ok: false, problem: 'Describe how to combine them' }
  return build(cur, backends, {
    backend: 'comfyui',
    model: 'combine',
    prompt: input.prompt,
    refs: [cur.asset.id, extra],
    how: 'combine',
  })
}

/** Remove background: SAM 2.1 cuts out the subject (or the picked segment). */
export function cutoutRecipe(
  cur: StudioItem,
  backends: readonly StudioBackend[],
  input: { mask?: string } = {},
): Recipe {
  return build(cur, backends, {
    backend: 'sam',
    model: 'cutout',
    prompt: 'Remove background',
    refs: [cur.asset.id],
    how: 'cutout',
    ...(input.mask !== undefined && { mask: input.mask }),
  })
}

export function relightRecipe(
  cur: StudioItem,
  backends: readonly StudioBackend[],
  input: { direction: RelightDirection; prompt?: string },
): Recipe {
  return build(cur, backends, {
    backend: 'comfyui',
    model: 'relight',
    prompt: typed(input.prompt, DEFAULT_RELIGHT_PROMPT),
    refs: [cur.asset.id],
    params: { direction: input.direction },
    how: 'relight',
  })
}

export function angleRecipe(
  cur: StudioItem,
  backends: readonly StudioBackend[],
  input: { angle: AngleId; prompt?: string },
): Recipe {
  return build(cur, backends, {
    backend: 'comfyui',
    model: 'angles',
    prompt: typed(input.prompt, DEFAULT_ANGLE_PROMPT),
    refs: [cur.asset.id],
    params: { angle: input.angle },
    how: 'angle',
  })
}

/** Upscale with SeedVR2; the prompt is the model's name (the preset takes none). */
export function upscaleRecipe(
  cur: StudioItem,
  backends: readonly StudioBackend[],
  input: { factor: UpscaleFactor },
): Recipe {
  const comfy = backends.find((b) => b.id === 'comfyui')
  const name = comfy?.models?.find((m) => m.id === 'upscale')?.name ?? 'Upscale'
  const size = comfy && upscaleSize(comfy, cur.asset.width, cur.asset.height, input.factor)
  return build(cur, backends, {
    backend: 'comfyui',
    model: 'upscale',
    prompt: name,
    refs: [cur.asset.id],
    ...(size !== undefined && { params: { size } }),
    how: 'upscale',
  })
}

/** Make video with LTX from the current version (and optionally to another version). */
export function videoRecipe(
  cur: StudioItem,
  backends: readonly StudioBackend[],
  input: { seconds: number; end?: string; prompt?: string },
): Recipe {
  return build(cur, backends, {
    backend: 'ltx',
    mode: 'video',
    prompt: typed(input.prompt, DEFAULT_VIDEO_PROMPT),
    frames: { start: cur.asset.id, ...(input.end !== undefined && { end: input.end }) },
    seconds: input.seconds,
    how: 'video',
  })
}

/** Regenerate: the current version's own job again, with a new random seed. */
export function regenerateRecipe(cur: StudioItem, backends: readonly StudioBackend[]): Recipe {
  const backend = backends.find((b) => b.id === cur.job.spec.backend)
  if (!backend) return { ok: false, problem: 'Not on this host' }
  if (!backend.available) return { ok: false, problem: backend.reason ?? `${backend.label} is off` }
  if (backend.paid) return { ok: false, problem: 'Paid engines run from the create bar' }
  const { seed: _seed, ...spec } = studioRemixSpec(cur.job)
  return { ok: true, op: withLineage(cur, spec, 'regenerate') }
}

/** Crop (local, no AI) to `rect`, fractions of the image. */
export function cropRecipe(
  cur: StudioItem,
  backends: readonly StudioBackend[],
  rect: CropRect,
): Recipe {
  const r = clampCrop(rect)
  return build(cur, backends, {
    backend: 'crop',
    model: 'crop',
    prompt: 'Crop',
    refs: [cur.asset.id],
    params: { x: r.x, y: r.y, w: r.w, h: r.h },
    how: 'crop',
  })
}

/** Smallest crop side, as a fraction of the image. */
export const MIN_CROP = 0.05

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000

/** `rect` kept inside the image and at least MIN_CROP on each side, rounded to 4 places (x + w never over 1). */
export function clampCrop(rect: CropRect): CropRect {
  let w = round4(Math.min(1, Math.max(MIN_CROP, rect.w)))
  let h = round4(Math.min(1, Math.max(MIN_CROP, rect.h)))
  const x = round4(Math.min(1 - w, Math.max(0, rect.x)))
  const y = round4(Math.min(1 - h, Math.max(0, rect.y)))
  while (x + w > 1) w = round4(w - 0.0001)
  while (y + h > 1) h = round4(h - 0.0001)
  return { x, y, w, h }
}

/** What a crop drag holds: the whole box, or one corner. */
export type CropGrip = 'move' | 'nw' | 'ne' | 'sw' | 'se'

/** `start` after dragging `grip` by (dx, dy), fractions of the image; stays inside it and at least MIN_CROP. */
export function dragCrop(grip: CropGrip, start: CropRect, dx: number, dy: number): CropRect {
  if (grip === 'move') {
    return {
      x: Math.min(1 - start.w, Math.max(0, start.x + dx)),
      y: Math.min(1 - start.h, Math.max(0, start.y + dy)),
      w: start.w,
      h: start.h,
    }
  }
  let left = start.x
  let top = start.y
  let right = start.x + start.w
  let bottom = start.y + start.h
  if (grip === 'nw' || grip === 'sw') left = Math.min(right - MIN_CROP, Math.max(0, left + dx))
  else right = Math.max(left + MIN_CROP, Math.min(1, right + dx))
  if (grip === 'nw' || grip === 'ne') top = Math.min(bottom - MIN_CROP, Math.max(0, top + dy))
  else bottom = Math.max(top + MIN_CROP, Math.min(1, bottom + dy))
  return { x: left, y: top, w: right - left, h: bottom - top }
}
