import { useEffect, useMemo, useState } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconRefresh } from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import {
  studioJobActive,
  studioRemixSpec,
  type StudioAsset,
  type StudioJob,
  type StudioSpec,
} from '@evaos/contract'
import { invoke } from '../ipc'
import { StudioComposer } from './StudioComposer'
import { StudioConfirm, type StudioQuote } from './StudioConfirm'
import { StudioGallery } from './StudioGallery'
import { StudioPicker } from './StudioPicker'
import { StudioQueue } from './StudioQueue'
import { StudioViewer } from './StudioViewer'
import { assetIndex, downloadName, pickableImages, readImageFile } from './studio-assets'
import {
  INITIAL_FORM,
  formBackend,
  formFromDraft,
  formProblem,
  formSpec,
  formWithAsset,
  settleForm,
  settleStudio,
  type StudioForm,
  type StudioSlot,
} from './studio-form'
import {
  applyStudioChange,
  keepStudioUpload,
  startStudio,
  studioRequest,
  studioStore,
  useStudio,
} from './studio-store'
import './studio.css'

/** How long the model prices wait for the settings to stop changing. */
const QUOTE_DEBOUNCE_MS = 400
/** The host prices a job by its settings; the prompt only has to be there. */
const PRICE_PROMPT = 'Price check'

const SLOT_TITLE: Record<StudioSlot, string> = {
  start: 'Start frame',
  mid: 'Mid frame',
  end: 'End frame',
  ref: 'Reference image',
}

/** The form with `asset` in the slot an upload or a pick was for. */
function placed(form: StudioForm, slot: StudioSlot, index: number, asset: string): StudioForm {
  if (slot !== 'ref') return { ...form, frames: { ...form.frames, [slot]: asset } }
  const refs = [...form.refs]
  refs[Math.min(index, refs.length)] = asset
  return { ...form, refs }
}

function fail(title: string, message: string): void {
  notifications.show({ title, message, color: 'red' })
}

/**
 * Studio: make images and videos on the Relay host. A composer (prompt, model or ComfyUI preset, settings,
 * keyframes and references) beside the queue and the gallery; a finished output opens full
 * screen with Remix, Use as frame, Download and Delete. Paid jobs only go out from the confirm
 * dialog, with the price Isaac saw.
 */
export function StudioPage(_props: { place: Place }) {
  useEffect(() => startStudio(), [])
  const view = useStudio((s) => s.view)
  const loadError = useStudio((s) => s.error)
  const request = useStudio((s) => s.request)
  const { backends, jobs } = view
  const [raw, setRaw] = useState<StudioForm>(INITIAL_FORM)
  const form = useMemo(() => settleStudio(raw, backends), [raw, backends])
  const backend = formBackend(form, backends)
  const problem = formProblem(form, backend)
  const assets = useMemo(() => assetIndex(view), [view])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState<string | null>(null)
  const [quotes, setQuotes] = useState<Record<string, number>>({})
  const [quotedBalance, setQuotedBalance] = useState<number | undefined>(undefined)
  const [confirm, setConfirm] = useState<StudioSpec | null>(null)
  const [quote, setQuote] = useState<StudioQuote>({ state: 'asking' })
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{ job: string; index: number } | null>(null)
  const [picking, setPicking] = useState<{ slot: StudioSlot; index: number } | null>(null)

  const change = (update: (f: StudioForm) => StudioForm): void => {
    setError(null)
    setRaw((f) => update(settleStudio(f, backends)))
  }

  // An agent's studio.open: a job for the viewer, or a draft for the composer.
  useEffect(() => {
    if (!request || (!view.loaded && 'draft' in request)) return
    studioStore.setState({ request: null })
    if ('job' in request) setViewing({ job: request.job, index: 0 })
    else setRaw((f) => formFromDraft(settleStudio(f, backends), request.draft))
  }, [request, view.loaded, backends])

  // Each model's price for the current settings, while a paid backend is picked.
  const models = backend?.paid ? (backend.models ?? []) : []
  const priceKey = backend?.paid
    ? JSON.stringify({ ...form, prompt: '', mode: null, model: null, ids: models.map((m) => m.id) })
    : ''
  useEffect(() => {
    if (!backend?.paid || priceKey === '') return
    let live = true
    const timer = setTimeout(() => {
      const asks = (backend.models ?? []).map(async (m) => {
        const f = settleForm({ ...form, mode: m.mode, model: m.id, prompt: PRICE_PROMPT }, backends)
        if (f.resolution === null) return null
        const a = await studioRequest({ kind: 'quote', spec: formSpec(f, backend) })
        return a.ok && a.credits !== undefined ? { id: m.id, a } : null
      })
      void Promise.all(asks).then((answers) => {
        if (!live) return
        const next: Record<string, number> = {}
        let balance: number | undefined
        for (const hit of answers) {
          if (!hit) continue
          next[hit.id] = hit.a.credits ?? 0
          balance = hit.a.balance ?? balance
        }
        setQuotes(next)
        setQuotedBalance(balance)
      })
    }, QUOTE_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // priceKey stands for every setting the prices depend on.
  }, [priceKey])

  const create = async (spec: StudioSpec): Promise<string | null> => {
    const answer = await studioRequest({ kind: 'create', spec })
    if (!answer.ok || !answer.job) return answer.error ?? "Relay didn't queue the job."
    applyStudioChange({ kind: 'job', job: answer.job })
    return null
  }

  const generate = async (): Promise<void> => {
    if (problem !== null || !backend) return
    const spec = formSpec(form, backend)
    if (backend.paid) {
      setConfirm(spec)
      setConfirmError(null)
      setQuote({ state: 'asking' })
      const a = await studioRequest({ kind: 'quote', spec })
      setQuote(
        a.ok && a.credits !== undefined
          ? { state: 'ready', credits: a.credits, balance: a.balance ?? backend.balance }
          : { state: 'failed', error: a.error ?? `${backend.label} didn't give a price.` },
      )
      return
    }
    setBusy(true)
    setError(await create(spec))
    setBusy(false)
  }

  const spend = async (credits: number): Promise<void> => {
    if (!confirm) return
    setBusy(true)
    const refused = await create({ ...confirm, confirmCredits: credits })
    setBusy(false)
    if (refused) setConfirmError(refused)
    else setConfirm(null)
  }

  const upload = async (slot: StudioSlot, index: number, file: File): Promise<void> => {
    const key = slot === 'ref' ? `ref:${index}` : slot
    setUploading(key)
    try {
      const image = await readImageFile(file)
      const a = await studioRequest({ kind: 'upload', image, name: file.name.slice(0, 200) })
      if (!a.ok || !a.asset) throw new Error(a.error ?? "Relay didn't keep the image.")
      const asset = a.asset
      keepStudioUpload(asset)
      change((f) => placed(f, slot, index, asset.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(null)
    }
  }

  const remix = (job: StudioJob): void => {
    setViewing(null)
    change((f) => formFromDraft(f, studioRemixSpec(job)))
  }

  const use = async (job: StudioJob, index: number, slot: StudioSlot): Promise<void> => {
    const output = job.outputs[index]
    if (!output) return
    let asset: StudioAsset = output
    if (output.kind === 'video') {
      const a = await studioRequest({ kind: 'frame', asset: output.id, at: 'last' })
      if (!a.ok || !a.asset) return fail("Couldn't take the last frame", a.error ?? '')
      asset = a.asset
      keepStudioUpload(asset)
    }
    setViewing(null)
    change((f) => formWithAsset(f, backends, asset.id, slot))
  }

  const download = async (job: StudioJob, index: number): Promise<void> => {
    const asset = job.outputs[index]
    if (!asset) return
    const r = await invoke('studio.download', { path: asset.path, name: downloadName(asset) })
    if (r.ok) notifications.show({ message: 'Saved to Downloads.', color: 'green' })
    else fail("Couldn't download it", r.error.message)
  }

  const remove = async (job: StudioJob): Promise<void> => {
    const a = await studioRequest({ kind: 'delete', id: job.id })
    if (!a.ok) return fail("Couldn't delete it", a.error ?? '')
    setViewing(null)
    applyStudioChange({ kind: 'removed', id: job.id })
  }

  const cancel = async (job: StudioJob): Promise<void> => {
    const a = await studioRequest({ kind: 'cancel', id: job.id })
    if (!a.ok) fail("Couldn't cancel it", a.error ?? '')
  }

  const refresh = async (): Promise<void> => {
    const a = await studioRequest({ kind: 'refresh' })
    if (!a.ok) fail("Couldn't refresh Studio", a.error ?? '')
  }

  const queue = jobs.filter((j) => studioJobActive(j) || j.state === 'failed')
  const done = jobs.filter((j) => j.state === 'done' && j.outputs.length > 0)
  const shown = viewing ? (jobs.find((j) => j.id === viewing.job) ?? null) : null
  const notice = !view.up
    ? "Relay isn't connected. Studio comes back when it is."
    : view.loaded && backends.length === 0
      ? "This Relay host doesn't have Studio."
      : null

  return (
    <div className="eva-studio" data-testid="page-studio">
      <div className="eva-studio-layout">
        <section className="eva-studio-side" aria-label="Composer">
          <div className="eva-studio-head">
            <h1 className="eva-studio-title" data-page-title>
              Studio
            </h1>
            <span className="eva-studio-spacer" />
            <Tooltip label="Refresh backends" openDelay={400}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Refresh backends"
                disabled={!view.up}
                onClick={() => void refresh()}
              >
                <IconRefresh size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          </div>
          {notice || loadError ? (
            <p className="eva-studio-notice" data-testid="studio-notice">
              {notice ?? loadError}
            </p>
          ) : null}
          <StudioComposer
            form={form}
            backend={backend}
            backends={backends}
            assets={assets}
            quotes={quotes}
            balance={quotedBalance ?? backend?.balance}
            problem={view.up ? problem : "Relay isn't connected."}
            error={error}
            busy={busy && confirm === null}
            uploading={uploading}
            onChange={change}
            onGenerate={() => void generate()}
            onFile={(slot, index, file) => void upload(slot, index, file)}
            onPick={(slot, index) => setPicking({ slot, index })}
          />
        </section>
        <section className="eva-studio-main" aria-label="Queue and gallery">
          <StudioQueue
            jobs={queue}
            backends={backends}
            onCancel={(j) => void cancel(j)}
            onRemix={remix}
            onDismiss={(j) => void remove(j)}
          />
          <StudioGallery jobs={done} onOpen={(job, index) => setViewing({ job: job.id, index })} />
        </section>
      </div>
      <StudioViewer
        job={shown && shown.state === 'done' ? shown : null}
        index={viewing?.index ?? 0}
        onIndex={(index) => setViewing((v) => (v ? { ...v, index } : v))}
        onClose={() => setViewing(null)}
        onRemix={remix}
        onUse={(job, index, slot) => void use(job, index, slot)}
        onDownload={(job, index) => void download(job, index)}
        onDelete={(job) => void remove(job)}
      />
      <StudioConfirm
        opened={confirm !== null}
        backend={backend?.label.replace(/\s*\(.*\)$/, '') ?? 'Higgsfield'}
        quote={quote}
        busy={busy}
        error={confirmError}
        onClose={() => setConfirm(null)}
        onConfirm={(credits) => void spend(credits)}
      />
      <StudioPicker
        opened={picking !== null}
        title={picking ? SLOT_TITLE[picking.slot] : ''}
        images={pickableImages(view)}
        onClose={() => setPicking(null)}
        onPick={(asset) => {
          if (picking) change((f) => placed(f, picking.slot, picking.index, asset.id))
          setPicking(null)
        }}
      />
    </div>
  )
}
