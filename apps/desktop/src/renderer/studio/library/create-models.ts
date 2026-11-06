// What the create bar can make originals with, and how a create with @ references is routed.
import {
  studioResolutions,
  type StudioAspect,
  type StudioBackend,
  type StudioBackendId,
  type StudioHow,
  type StudioModel,
  type StudioParent,
  type StudioReference,
  type StudioSpec,
} from '@evaos/contract'

/** One entry of the "Create with" picker. */
export interface CreateChoice {
  /** `backend` or `backend:model`. */
  key: string
  label: string
  note: string
  group: 'Local' | 'ChatGPT' | 'Paid'
  backend: StudioBackendId
  model?: string
  paid: boolean
  /** Why it cannot run now (the host's reason). */
  off?: string
}

export const choiceKey = (backend: string, model?: string): string =>
  model === undefined ? backend : `${backend}:${model}`

/** The key a job is filtered by and labelled with (its backend and model). */
export function engineKey(spec: Pick<StudioSpec, 'backend' | 'model'>): string {
  return choiceKey(spec.backend, spec.model)
}

/** A short engine name for a job: the model's name, else the backend's label. */
export function engineLabel(
  spec: Pick<StudioSpec, 'backend' | 'model'>,
  backends: readonly StudioBackend[],
): string {
  const backend = backends.find((b) => b.id === spec.backend)
  const model =
    spec.model === undefined ? undefined : backend?.models?.find((m) => m.id === spec.model)
  return model?.name ?? backend?.label ?? spec.model ?? spec.backend
}

const off = (b: StudioBackend): string | undefined =>
  b.available ? undefined : (b.reason ?? `${b.label} can't run right now`)

/**
 * Originals only: MOSS-Image and its fine-tunes (moss), FLUX.2 klein create (comfyui), Codex
 * image, then the paid backends' image models. Only what the host lists.
 */
export function createChoices(backends: readonly StudioBackend[]): CreateChoice[] {
  const out: CreateChoice[] = []
  const moss = backends.find((b) => b.id === 'moss')
  for (const m of moss?.models?.filter((x) => x.mode === 'image') ?? []) {
    out.push({
      key: choiceKey('moss', m.id),
      label: m.name,
      note: m.id === 'moss-image' ? 'Local, text and layouts' : 'Local, MOSS-Image fine-tune',
      group: 'Local',
      backend: 'moss',
      model: m.id,
      paid: false,
      off: moss ? off(moss) : undefined,
    })
  }
  const comfy = backends.find((b) => b.id === 'comfyui')
  const klein = comfy?.models?.find((m) => m.id === 'klein-create')
  if (comfy && klein) {
    out.push({
      key: choiceKey('comfyui', klein.id),
      label: 'FLUX.2 klein create',
      note: 'Local, fast',
      group: 'Local',
      backend: 'comfyui',
      model: klein.id,
      paid: false,
      off: off(comfy),
    })
  }
  const codex = backends.find((b) => b.id === 'codex-image')
  if (codex) {
    out.push({
      key: 'codex-image',
      label: 'Codex image',
      note: 'Free with ChatGPT, takes references',
      group: 'ChatGPT',
      backend: 'codex-image',
      paid: false,
      off: off(codex),
    })
  }
  for (const b of backends.filter((x) => x.paid && x.mode === 'image')) {
    out.push({
      key: b.id,
      label: b.label,
      note: 'Paid, priced before it runs',
      group: 'Paid',
      backend: b.id,
      paid: true,
      off: off(b),
    })
  }
  for (const b of backends.filter((x) => x.paid)) {
    for (const m of b.models?.filter((x) => x.mode === 'image') ?? []) {
      out.push({
        key: choiceKey(b.id, m.id),
        label: m.name,
        note: 'Paid, priced before it runs',
        group: 'Paid',
        backend: b.id,
        model: m.id,
        paid: true,
        off: off(b),
      })
    }
  }
  // A paid backend with image models is listed by its models only.
  return out.filter(
    (c) =>
      !(c.model === undefined && c.paid && out.some((o) => o.backend === c.backend && o.model)),
  )
}

/** The model on a backend, if it lists it. */
export function modelOf(
  backend: StudioBackend | undefined,
  model?: string,
): StudioModel | undefined {
  return model === undefined ? undefined : backend?.models?.find((m) => m.id === model)
}

export interface RoutedCreate {
  spec: StudioSpec
  parent?: StudioParent
}

export interface CreateInput {
  choice: CreateChoice
  prompt: string
  aspect: StudioAspect
  /** @ picks: saved reference asset ids or image asset ids. */
  refs: readonly string[]
  seed?: number
  steps?: number | null
}

/** At most this many references go to the FLUX.2 klein presets. */
export const MAX_KLEIN_REFS = 2

/** True when the create bar's refs make FLUX.2 klein do the job (the muted hint). */
export function refsUseKlein(choice: CreateChoice | undefined, refs: readonly string[]): boolean {
  return refs.length > 0 && choice !== undefined && choice.backend !== 'codex-image'
}

/**
 * The spec (and lineage) a create makes. Without refs: the picked model. With refs: Codex image
 * becomes Codex edit; anything else goes to FLUX.2 klein on ComfyUI (one Character: `character`,
 * one other: `klein-edit`, two: `combine`). A first ref that is a library image is the parent.
 * Returns a line for the UI when it can't be made.
 */
export function routeCreate(
  input: CreateInput,
  backends: readonly StudioBackend[],
  references: readonly StudioReference[],
): RoutedCreate | string {
  const prompt = input.prompt.trim()
  if (prompt === '') return 'Write a prompt first'
  const refs = [...input.refs]
  let backendId: StudioBackendId = input.choice.backend
  let model = input.choice.model
  let how: StudioHow | undefined
  if (refs.length > 0) {
    const savedOf = (id: string): StudioReference | undefined =>
      references.find((r) => r.asset.id === id)
    if (input.choice.backend === 'codex-image') {
      backendId = 'codex-edit'
      model = undefined
      how = 'edit'
    } else {
      if (refs.length > MAX_KLEIN_REFS)
        return `FLUX.2 klein takes at most ${MAX_KLEIN_REFS} references`
      backendId = 'comfyui'
      if (refs.length === 2) {
        model = 'combine'
        how = 'combine'
      } else if (savedOf(refs[0]!)?.kind === 'character') {
        model = 'character'
        how = 'character'
      } else {
        model = 'klein-edit'
        how = 'edit'
      }
    }
  }
  const backend = backends.find((b) => b.id === backendId)
  if (!backend) return `This Relay host has no ${backendId} backend`
  if (!backend.available) return backend.reason ?? `${backend.label} can't run right now`
  if (model !== undefined && !backend.models?.some((m) => m.id === model)) {
    return `${backend.label} has no ${model} preset`
  }
  const resolution = studioResolutions(backend, input.aspect, model)[0]?.id
  if (resolution === undefined) return `${backend.label} has no ${input.aspect} size`
  const hasSteps = modelOf(backend, model)?.inputs?.some(
    (i) => i.id === 'steps' && i.kind === 'number',
  )
  const spec: StudioSpec = {
    mode: 'image',
    backend: backendId,
    prompt,
    aspect: input.aspect,
    resolution,
    ...(model === undefined ? {} : { model }),
    ...(input.seed !== undefined && backend.seed ? { seed: input.seed } : {}),
    ...(refs.length > 0 ? { refs } : {}),
    ...(hasSteps && input.steps !== null && input.steps !== undefined
      ? { params: { steps: input.steps } }
      : {}),
  }
  const first = refs[0]
  const parent =
    first !== undefined && how !== undefined && !references.some((r) => r.asset.id === first)
      ? { asset: first, how }
      : undefined
  return parent ? { spec, parent } : { spec }
}
