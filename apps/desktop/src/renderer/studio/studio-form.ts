// The composer's form: what Isaac picked, kept consistent with the host's backends (a backend of
// the mode, a resolution the backend or model offers for the aspect, an allowed length), checked
// before Generate, and turned into the spec the host takes.
import {
  studioFrameSlots,
  studioRefs,
  studioResolutions,
  studioSeconds,
  type StudioAspect,
  type StudioBackend,
  type StudioBackendId,
  type StudioDraft,
  type StudioFrameSlot,
  type StudioMode,
  type StudioModel,
  type StudioSpec,
} from '@evaos/contract'

export interface StudioForm {
  mode: StudioMode
  backend: StudioBackendId | null
  prompt: string
  aspect: StudioAspect
  resolution: string | null
  seconds: number | null
  /** null: a random seed. */
  seed: number | null
  /** Kept across backend switches; only the slots the backend takes are sent. */
  frames: Partial<Record<StudioFrameSlot, string>>
  refs: string[]
  model: string | null
  /** A preset's own inputs Isaac changed (an option id or a number); the rest take the preset's defaults. */
  params: Record<string, string | number>
}

export const INITIAL_FORM: StudioForm = {
  mode: 'image',
  backend: null,
  prompt: '',
  aspect: '16:9',
  resolution: null,
  seconds: null,
  seed: null,
  frames: {},
  refs: [],
  model: null,
  params: {},
}

/** The model (Higgsfield model or ComfyUI preset) the form names on its backend. */
export function formModel(
  form: StudioForm,
  backend: StudioBackend | null,
): StudioModel | undefined {
  return backend?.models?.find((m) => m.id === form.model)
}

/** The form's backend, when the host has it. */
export function formBackend(
  form: StudioForm,
  backends: readonly StudioBackend[],
): StudioBackend | null {
  return backends.find((b) => b.id === form.backend && takesMode(b, form.mode)) ?? null
}

/** A backend makes `mode` when it is of that mode or one of its models (a Higgsfield model) is. */
function takesMode(backend: StudioBackend, mode: StudioMode): boolean {
  return backend.mode === mode || !!backend.models?.some((m) => m.mode === mode)
}

/** The form made consistent with the host's backends after any change. */
export function settleForm(form: StudioForm, backends: readonly StudioBackend[]): StudioForm {
  const ofMode = backends.filter((b) => takesMode(b, form.mode))
  const backend =
    ofMode.find((b) => b.id === form.backend) ??
    ofMode.find((b) => b.available && !b.paid) ??
    ofMode.find((b) => b.available) ??
    ofMode[0]
  if (!backend)
    return { ...form, backend: null, model: null, resolution: null, seconds: null, params: {} }
  const models = backend.models?.filter((m) => m.mode === form.mode) ?? []
  const model =
    models.length === 0
      ? null
      : (models.find((m) => m.id === form.model)?.id ?? models[0]?.id ?? null)
  const resolutions = studioResolutions(backend, form.aspect, model ?? undefined)
  const resolution =
    resolutions.find((r) => r.id === form.resolution)?.id ?? resolutions[0]?.id ?? null
  const lengths = form.mode === 'video' ? studioSeconds(backend, model ?? undefined) : []
  const seconds =
    form.seconds !== null && lengths.includes(form.seconds) ? form.seconds : (lengths[0] ?? null)
  const inputs = backend.models?.find((m) => m.id === model)?.inputs ?? []
  const params = Object.fromEntries(
    Object.entries(form.params).filter(([id]) => inputs.some((input) => input.id === id)),
  )
  return { ...form, backend: backend.id, model, resolution, seconds, params }
}

/** Why Generate cannot go yet, in one line; null when it can. */
export function formProblem(form: StudioForm, backend: StudioBackend | null): string | null {
  if (!backend) return 'The Relay host has no backend for this mode.'
  if (!backend.available) return backend.reason ?? `${backend.label} can't run right now.`
  const preset = formModel(form, backend)
  if (preset?.prompt !== false && form.prompt.trim() === '') return 'Write a prompt first.'
  if (form.resolution === null) return 'Pick a resolution.'
  if (form.mode === 'video' && form.seconds === null && backend.seconds.length > 0) {
    return 'Pick a length.'
  }
  const slots = studioFrameSlots(backend, form.model ?? undefined)
  const has = (slot: StudioFrameSlot): boolean => slots.includes(slot) && !!form.frames[slot]
  if (backend.id === 'ltx' && has('start') !== has('end')) {
    return 'Local video needs both a start and an end frame, or neither.'
  }
  if (has('mid') && !(has('start') && has('end'))) {
    return 'A mid frame needs a start and an end frame.'
  }
  const refs = studioRefs(backend, form.model ?? undefined)
  if (form.mode === 'image' && form.refs.length < refs.min) {
    return refs.min === 1 ? 'Add a reference image to edit.' : `Add ${refs.min} reference images.`
  }
  return null
}

/** The spec Generate sends (check formProblem first). */
export function formSpec(form: StudioForm, backend: StudioBackend): StudioSpec {
  const slots = studioFrameSlots(backend, form.model ?? undefined)
  const frames = Object.fromEntries(
    slots.flatMap((slot) => (form.frames[slot] ? [[slot, form.frames[slot]]] : [])),
  )
  const { max } = studioRefs(backend, form.model ?? undefined)
  const refs = max > 0 ? form.refs.slice(0, max) : []
  const preset = formModel(form, backend)
  const params = Object.fromEntries(
    Object.entries(form.params).filter(([id]) => preset?.inputs?.some((input) => input.id === id)),
  )
  return {
    mode: form.mode,
    backend: backend.id,
    prompt: preset?.prompt === false ? preset.name : form.prompt.trim(),
    aspect: form.aspect,
    resolution: form.resolution ?? '',
    ...(form.mode === 'video' && form.seconds !== null ? { seconds: form.seconds } : {}),
    ...(backend.seed && form.seed !== null ? { seed: form.seed } : {}),
    ...(Object.keys(frames).length > 0 ? { frames } : {}),
    ...(refs.length > 0 ? { refs } : {}),
    ...(form.model !== null ? { model: form.model } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  }
}

/** The form filled from a remix or an agent's draft; what it leaves out stays as it was. */
export function formFromDraft(form: StudioForm, draft: StudioDraft): StudioForm {
  const backend = draft.backend ?? form.backend
  return {
    mode: draft.mode ?? form.mode,
    backend,
    prompt: draft.prompt ?? form.prompt,
    aspect: draft.aspect ?? form.aspect,
    resolution: draft.resolution ?? form.resolution,
    seconds: draft.seconds ?? form.seconds,
    seed: draft.seed ?? (draft.prompt === undefined ? form.seed : null),
    frames: draft.frames ?? (draft.backend === undefined ? form.frames : {}),
    refs: draft.refs ?? (draft.backend === undefined ? form.refs : []),
    model: draft.model ?? (draft.backend === undefined ? form.model : null),
    params:
      draft.params ?? (draft.backend === undefined && draft.model === undefined ? form.params : {}),
  }
}

/** Where "Use as frame" puts an asset: a keyframe slot, or a reference image of an edit. */
export type StudioSlot = StudioFrameSlot | 'ref'

/**
 * The form with `asset` in `slot`, switching to a backend that takes that slot when the current
 * one does not (a video backend for a keyframe, an edit for a reference).
 */
export function formWithAsset(
  form: StudioForm,
  backends: readonly StudioBackend[],
  asset: string,
  slot: StudioSlot,
): StudioForm {
  const current = formBackend(form, backends)
  if (slot === 'ref') {
    const edits = (b: StudioBackend | null): b is StudioBackend =>
      !!b && b.mode === 'image' && b.refs > 0
    const backend = edits(current)
      ? current
      : (backends.find((b) => edits(b) && b.available) ?? backends.find(edits))
    if (!backend) return form
    const { max } = studioRefs(backend, backend === current ? (form.model ?? undefined) : undefined)
    const refs = form.refs.includes(asset)
      ? form.refs
      : [...form.refs, asset].slice(-Math.max(1, max))
    return settleForm({ ...form, mode: 'image', backend: backend.id, refs }, backends)
  }
  const keyframes = (b: StudioBackend | null): b is StudioBackend =>
    !!b &&
    b.mode === 'video' &&
    studioFrameSlots(b, b === current ? (form.model ?? undefined) : undefined).includes(slot)
  const backend = keyframes(current)
    ? current
    : (backends.find((b) => keyframes(b) && b.available && !b.paid) ??
      backends.find((b) => keyframes(b) && b.available) ??
      backends.find(keyframes))
  if (!backend) return form
  return settleForm(
    { ...form, mode: 'video', backend: backend.id, frames: { ...form.frames, [slot]: asset } },
    backends,
  )
}

/** The quiet groups of the Models dropdown, in the order they show. */
export type StudioGroup = 'Local' | 'ChatGPT' | 'Paid'
export const STUDIO_GROUPS: readonly StudioGroup[] = ['Local', 'ChatGPT', 'Paid']

/** One line of the model picker (or one ComfyUI preset): a model, or a whole model-less backend. */
export interface StudioEntry {
  /** Backend and model as one string (see entryKey). */
  key: string
  backend: StudioBackendId
  /** null: the backend has no models to pick between. */
  model: string | null
  label: string
  mode: StudioMode
  available: boolean
  reason?: string
  paid: boolean
  group: StudioGroup
  /** A preset's one line. */
  description?: string
}

const KEY_SEPARATOR = '|'

/** The value one entry carries in a select (backend ids hold no `|`; model ids may). */
export function entryKey(backend: StudioBackendId, model: string | null): string {
  return model === null ? backend : `${backend}${KEY_SEPARATOR}${model}`
}

export function decodeEntryKey(key: string): { backend: StudioBackendId; model: string | null } {
  const at = key.indexOf(KEY_SEPARATOR)
  return at < 0
    ? { backend: key as StudioBackendId, model: null }
    : { backend: key.slice(0, at) as StudioBackendId, model: key.slice(at + 1) }
}

const isComfy = (b: StudioBackend): boolean => b.id === 'comfyui' || b.id === 'comfyui-video'

function groupOf(b: StudioBackend): StudioGroup {
  if (b.paid) return 'Paid'
  return b.id === 'codex-image' || b.id === 'codex-edit' ? 'ChatGPT' : 'Local'
}

const imageFirst = (entries: StudioEntry[]): StudioEntry[] => [
  ...entries.filter((e) => e.mode === 'image'),
  ...entries.filter((e) => e.mode !== 'image'),
]

/**
 * Everything the Models dropdown lists, in group order (Local, ChatGPT, Paid), image before video
 * inside a group, host order otherwise. ComfyUI's presets are not here (see studioPresets).
 */
export function studioEntries(backends: readonly StudioBackend[]): StudioEntry[] {
  const all: StudioEntry[] = []
  for (const b of backends) {
    if (isComfy(b)) continue
    const group = groupOf(b)
    if (b.available && b.models && b.models.length > 0) {
      for (const m of b.models) {
        all.push({
          key: entryKey(b.id, m.id),
          backend: b.id,
          model: m.id,
          label: m.name,
          mode: m.mode,
          available: true,
          paid: b.paid,
          group,
          ...(m.description ? { description: m.description } : {}),
        })
      }
    } else {
      all.push({
        key: entryKey(b.id, null),
        backend: b.id,
        model: null,
        label: b.label,
        mode: b.mode,
        available: b.available,
        ...(b.reason ? { reason: b.reason } : {}),
        paid: b.paid,
        group,
      })
    }
  }
  return STUDIO_GROUPS.flatMap((group) => imageFirst(all.filter((e) => e.group === group)))
}

/** ComfyUI's presets (image ones, then video ones) from whichever ComfyUI backend can run. */
export function studioPresets(backends: readonly StudioBackend[]): {
  presets: StudioEntry[]
  /** Why there are none, when there are none. */
  reason: string | null
} {
  const comfy = backends.filter(isComfy)
  const presets = imageFirst(
    comfy.flatMap((b) =>
      b.available
        ? (b.models ?? []).map((m): StudioEntry => ({
            key: entryKey(b.id, m.id),
            backend: b.id,
            model: m.id,
            label: m.name,
            mode: m.mode,
            available: true,
            paid: false,
            group: 'Local',
            ...(m.description ? { description: m.description } : {}),
          }))
        : [],
    ),
  )
  if (presets.length > 0) return { presets, reason: null }
  const reason = comfy.find((b) => b.reason)?.reason
  return { presets: [], reason: reason ?? 'ComfyUI has no presets on this host.' }
}

/** Which of the two pickers the form is on. */
export type StudioTab = 'models' | 'comfyui'

export function studioTab(form: Pick<StudioForm, 'backend'>): StudioTab {
  return form.backend === 'comfyui' || form.backend === 'comfyui-video' ? 'comfyui' : 'models'
}

/** The first available entry, free ones first; the first one when none can run. */
export function defaultEntry(entries: readonly StudioEntry[]): StudioEntry | null {
  return entries.find((e) => e.available && !e.paid) ?? entries.find((e) => e.available) ?? null
}

/**
 * Where a tab starts: the choice last made on it when still offered, else its default (the first
 * available entry, the first preset).
 */
export function tabChoice(
  tab: StudioTab,
  backends: readonly StudioBackend[],
  last: string | null | undefined,
): StudioEntry | null {
  const list = tab === 'models' ? studioEntries(backends) : studioPresets(backends).presets
  return list.find((e) => e.key === last && e.available) ?? defaultEntry(list)
}

/** The form with an entry (or preset) chosen: mode, backend and model together, then settled. */
export function selectEntry(
  form: StudioForm,
  backends: readonly StudioBackend[],
  entry: Pick<StudioEntry, 'mode' | 'backend' | 'model'>,
): StudioForm {
  return settleForm(
    { ...form, mode: entry.mode, backend: entry.backend, model: entry.model },
    backends,
  )
}

/** The key of the entry or preset the form is on, when the host lists one for it. */
export function formEntryKey(form: StudioForm, backends: readonly StudioBackend[]): string | null {
  const listed = [...studioEntries(backends), ...studioPresets(backends).presets]
  const hit =
    listed.find((e) => e.backend === form.backend && e.model === form.model) ??
    listed.find((e) => e.backend === form.backend && e.model === null)
  return hit?.key ?? null
}

/**
 * The form made consistent with the host's backends, falling to the first available model of the
 * picker when what it names is not offered (a fresh form, a backend the host dropped).
 */
export function settleStudio(form: StudioForm, backends: readonly StudioBackend[]): StudioForm {
  const first = defaultEntry(studioEntries(backends))
  if (form.backend === null)
    return first ? selectEntry(form, backends, first) : settleForm(form, backends)
  const settled = settleForm(form, backends)
  if (formEntryKey(settled, backends) !== null) return settled
  return first ? selectEntry(settled, backends, first) : settled
}
