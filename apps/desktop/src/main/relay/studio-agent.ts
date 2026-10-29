// The studio.* agent actions that run in main: an agent queues a free Studio job on the Relay host
// (origin `agent`, so the host also refuses anything paid) or reads the queue and gallery with
// links it can fetch over the host's http port. studio.open runs in the page (renderer/agent).
import {
  StudioSpecSchema,
  studioEtaLabel,
  studioResolutions,
  studioSeconds,
  type AgentParams,
  type AgentResult,
  type AgentRunners,
  type StudioBackend,
  type StudioJob,
  type StudioMode,
} from '@evaos/contract'
import type { RelayCanvas, RelayStudio } from './client'

const LIST_LIMIT = 20

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

const PAID_REFUSAL =
  'Higgsfield is paid, and Studio never runs paid jobs for agents. Call studio.open with a `draft` (backend higgsfield, prompt, model...) so Isaac sees the cost and confirms it himself.'

/** A job as agents read it: its outputs as links on the host's http origin. */
export function compactJob(job: StudioJob, origin: string | null) {
  const host = origin ?? ''
  return {
    id: job.id,
    state: job.state,
    prompt: job.spec.prompt,
    mode: job.spec.mode,
    backend: job.spec.backend,
    ...(job.spec.model === undefined ? {} : { model: job.spec.model }),
    progress: job.progress,
    eta: studioEtaLabel(job.etaMs) ?? null,
    ...(job.note === undefined ? {} : { note: job.note }),
    ...(job.error === undefined ? {} : { error: job.error }),
    createdAt: job.createdAt,
    outputs: job.outputs.map((o) => ({
      id: o.id,
      kind: o.kind,
      mimeType: o.mimeType,
      url: `${host}${o.path}`,
      thumb: `${host}${o.thumb}`,
      width: o.width,
      height: o.height,
      ...(o.durationMs === undefined ? {} : { durationMs: o.durationMs }),
      size: o.size,
    })),
  }
}

/** The backend a generate asks for, or the default for its mode (an edit when refs are given). */
function pickBackend(
  backends: readonly StudioBackend[],
  params: AgentParams<'studio.generate'>,
): { backend: StudioBackend; mode: StudioMode } {
  const named = params.backend
  const mode =
    params.mode ?? (named ? backends.find((b) => b.id === named)?.mode : undefined) ?? 'image'
  const id =
    named ?? (mode === 'video' ? 'ltx' : params.refs?.length ? 'codex-edit' : 'codex-image')
  const backend = backends.find((b) => b.id === id)
  if (!backend) fail('not-found', `The Relay host has no ${id} backend`)
  if (backend.paid) fail('paid-backend', PAID_REFUSAL)
  if (backend.mode !== mode) fail('invalid-params', `${backend.label} makes ${backend.mode}s`)
  if (!backend.available) {
    fail('backend-unavailable', backend.reason ?? `${backend.label} can't run right now`)
  }
  return { backend, mode }
}

export function studioRunners(
  relay: RelayStudio & Pick<RelayCanvas, 'canvasOrigin'>,
  open: (params: AgentParams<'studio.open'>) => Promise<AgentResult>,
): Pick<AgentRunners<'main'>, 'studio.generate' | 'studio.list'> {
  return {
    'studio.generate': async (params) => {
      if (params.backend === 'higgsfield') fail('paid-backend', PAID_REFUSAL)
      const state = relay.studio() ?? (await relay.studioList())
      if (state === null) fail('relay-unavailable', "Relay isn't connected, so Studio can't run.")
      const { backend, mode } = pickBackend(state.backends, params)
      const aspect = params.aspect ?? (mode === 'video' ? '16:9' : '1:1')
      const offered = studioResolutions(backend, aspect, params.model)
      const resolution = params.resolution ?? offered[0]?.id
      if (resolution === undefined || !offered.some((r) => r.id === resolution)) {
        const ids = offered.map((r) => r.id).join(', ') || 'none'
        fail('invalid-params', `${backend.label} at ${aspect} offers resolutions: ${ids}`)
      }
      const spec = StudioSpecSchema.safeParse({
        mode,
        backend: backend.id,
        prompt: params.prompt,
        aspect,
        resolution,
        seconds:
          mode === 'video'
            ? (params.seconds ?? studioSeconds(backend, params.model)[0])
            : undefined,
        seed: params.seed,
        frames: params.frames,
        refs: params.refs,
        model: params.model,
      })
      if (!spec.success) fail('invalid-params', spec.error.message)
      const answer = await relay.studioRequest({ kind: 'create', spec: spec.data, origin: 'agent' })
      if (!answer.ok || !answer.job) {
        fail('host-refused', answer.error ?? "Relay didn't queue the job")
      }
      const job = compactJob(answer.job, relay.canvasOrigin())
      if (!params.open) return { job }
      const shown = await open({
        job: answer.job.id,
        ...(params.scope === undefined ? {} : { scope: params.scope }),
      })
      return { job, opened: shown.ok ? shown.value : { error: shown.message } }
    },
    'studio.list': async ({ state, limit }) => {
      const studio = await relay.studioList()
      if (studio === null)
        fail('relay-unavailable', "Relay isn't connected, so there is no Studio.")
      const origin = relay.canvasOrigin()
      return {
        up: relay.studioUp(),
        backends: studio.backends,
        jobs: studio.jobs
          .filter((j) => state === undefined || j.state === state)
          .slice(0, limit ?? LIST_LIMIT)
          .map((j) => compactJob(j, origin)),
      }
    },
  }
}
