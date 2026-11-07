import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import {
  IconArrowLeft,
  IconChevronLeft,
  IconChevronRight,
  IconLayoutColumns,
  IconLayoutSidebarRight,
  IconMinus,
  IconPlayerPlayFilled,
  IconPlus,
  IconSwitchHorizontal,
} from '@tabler/icons-react'
import {
  studioFamily,
  studioJobActive,
  studioRootOf,
  studioVersions,
  type StudioJob,
  type StudioSegments,
} from '@evaos/contract'
import { DISMISS_PRIORITY, useDismissable } from '../../hotkeys/dismiss'
import { cancelJob, createJobs, mediaSrc, toast, trashAssets, useLibrary } from '../library/actions'
import { QueueIndicator } from '../library/menus'
import { applyStudioChange, studioRequest, useStudio } from '../studio-store'
import { EditorBar } from './EditorBar'
import { EditorCanvas } from './EditorCanvas'
import { EditorPanel } from './EditorPanel'
import {
  clampCrop,
  combineRecipe,
  cropRecipe,
  editRecipe,
  type CropRect,
  type EditEngine,
  type Recipe,
} from './recipes'
import './editor.css'

const ZOOM_STEP = 1.25
const MIN_ZOOM = 0.25
const MAX_ZOOM = 8
const START_CROP: CropRect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }

/** True when a key belongs to a text field rather than the editor. */
function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  )
}

/**
 * Studio's full-screen editor for one image and its versions: the versions strip, the canvas
 * (zoom, compare with the parent, the generating overlay), the describe-your-edit bar and the
 * tools panel. Every action is one `create` whose parent is the version on screen.
 */
export function StudioEditor({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const lib = useLibrary()
  const loaded = useStudio((s) => s.view.loaded)
  const [sel, setSel] = useState(assetId)
  const cur = lib.lineage.byId.get(sel)
  const root = cur ? studioRootOf(sel, lib.lineage) : undefined
  const versions = useMemo(
    () => (root ? studioVersions(root.asset.id, lib.lineage) : []),
    [root, lib.lineage],
  )
  const vi = versions.findIndex((v) => v.asset.id === sel)
  const parentId = cur?.job.parent?.asset
  const before = parentId === undefined ? undefined : lib.lineage.byId.get(parentId)
  const isVideo = cur?.asset.kind === 'video'

  /** Queued or running children of any version here, oldest first. */
  const pending = useMemo(() => {
    const ids = new Set(versions.map((v) => v.asset.id))
    return lib.jobs
      .filter((j) => studioJobActive(j) && j.parent !== undefined && ids.has(j.parent.asset))
      .sort((a, b) => a.createdAt - b.createdAt)
  }, [lib.jobs, versions])
  const mine = pending.filter((j) => j.parent?.asset === sel)
  const curJob: StudioJob | undefined = mine.find((j) => j.state === 'running') ?? mine[0]

  const [sending, setSending] = useState(false)
  const busy = curJob !== undefined || sending
  /** The pending job whose slot is on screen (shown under the generating overlay); null shows a version. */
  const [viewing, setViewing] = useState<string | null>(null)
  const viewingJob = pending.find((j) => j.id === viewing)
  const [hold, setHold] = useState(false)
  const [split, setSplit] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState(1)
  const [panel, setPanel] = useState(true)
  const [segment, setSegment] = useState<string | null>(null)
  const [crop, setCrop] = useState<CropRect | null>(null)
  const [prompt, setPrompt] = useState('')
  const [engine, setEngine] = useState<EditEngine>('qwen')
  const [refs, setRefs] = useState<string[]>([])
  const [picking, setPicking] = useState(false)
  const [segmentErrors, setSegmentErrors] = useState<Record<string, string>>({})
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => setSel(assetId), [assetId])
  useEffect(() => {
    setSegment(null)
    setCrop(null)
    setHold(false)
    setZoom(1)
  }, [sel])
  useEffect(() => {
    if (loaded && !cur) onClose()
  }, [loaded, cur, onClose])

  // A pending slot whose job finished or went away goes back to showing a version.
  useEffect(() => {
    if (viewing !== null && !pending.some((j) => j.id === viewing)) setViewing(null)
  }, [viewing, pending])

  // A child job of a version that finishes lands in the strip. It is selected only when its slot is on
  // screen, so previewing an earlier version while it generates is never interrupted; a failure says so.
  const watched = useRef(new Set<string>())
  useEffect(() => {
    for (const id of watched.current) {
      const job = lib.jobs.find((j) => j.id === id)
      if (job && studioJobActive(job)) continue
      watched.current.delete(id)
      const out = job?.outputs.find((o) => o.deletedAt === undefined)
      if (job?.state === 'done' && out) {
        if (viewing === id) setSel(out.id)
      } else if (job?.state === 'failed')
        toast(job.error ? `Edit failed: ${job.error}` : 'Edit failed')
    }
    for (const j of pending) watched.current.add(j.id)
  }, [lib.jobs, pending, viewing])

  // SAM 2.1 segments for an image version, asked once per version while the panel is open.
  const segments = useStudio((s) => s.view.segments[sel] as StudioSegments | undefined)
  const asked = useRef(new Set<string>())
  const askSegments = useCallback((asset: string) => {
    asked.current.add(asset)
    setSegmentErrors(({ [asset]: _gone, ...rest }) => rest)
    void studioRequest({ kind: 'segment', asset }).then((a) => {
      if (a.ok && a.segments) applyStudioChange({ kind: 'segments', segments: a.segments })
      else if (!a.ok) {
        setSegmentErrors((e) => ({ ...e, [asset]: a.error ?? 'SAM 2.1 could not run' }))
      }
    })
  }, [])
  useEffect(() => {
    if (!panel || !cur || cur.asset.kind !== 'image' || asked.current.has(sel)) return
    if (segments) asked.current.add(sel)
    else askSegments(sel)
  }, [panel, cur, sel, segments, askSegments])
  const picked =
    segments?.state === 'done' ? segments.segments.find((s) => s.id === segment) : undefined

  const selectVersion = useCallback((id: string) => {
    setViewing(null)
    setSel(id)
  }, [])
  const viewPending = (j: StudioJob): void => {
    if (j.parent) setSel(j.parent.asset)
    setViewing(j.id)
  }

  const go = useCallback(
    (d: number) => {
      const v = versions[vi + d]
      if (v) selectVersion(v.asset.id)
    },
    [versions, vi, selectVersion],
  )

  const close = useCallback(() => {
    if (crop) setCrop(null)
    else if (picking) {
      setPicking(false)
      setPrompt((t) => t.replace(/@$/, ''))
    } else onClose()
  }, [crop, picking, onClose])
  useDismissable(DISMISS_PRIORITY.overlay, close)

  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === ' ') {
        e.preventDefault()
        if (!e.repeat && before && !isVideo) setHold(true)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        go(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        go(1)
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key !== ' ') return
      if (!typing(e.target)) e.preventDefault()
      setHold(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [go, before, isVideo])

  if (!cur) return <div className="ed" data-testid="studio-editor" />

  const run = (recipe: Recipe): void => {
    if (!recipe.ok) {
      toast(recipe.problem)
      return
    }
    setSending(true)
    void createJobs(recipe.op)
      .then((a) => {
        if (!a.ok) return
        // Its progress is its own slot after the versions, shown at once; the versions stay one click away.
        setViewing((a.jobs?.[0] ?? a.job)?.id ?? null)
        setPrompt('')
        setRefs([])
        setSegment(null)
        setPicking(false)
        setCrop(null)
      })
      .finally(() => setSending(false))
  }
  const send = (): void =>
    run(
      refs.length > 0
        ? combineRecipe(cur, lib.backends, { prompt, refs })
        : editRecipe(cur, lib.backends, {
            engine,
            prompt,
            ...(picked !== undefined && { mask: picked.id }),
          }),
    )
  const remove = (): void => {
    // The version goes with the edits made from it; the original takes the whole image.
    const gone = studioFamily([cur.asset.id], lib.lineage)
    const next =
      versions.slice(vi + 1).find((v) => !gone.includes(v.asset.id)) ??
      versions
        .slice(0, vi)
        .reverse()
        .find((v) => !gone.includes(v.asset.id))
    trashAssets([cur.asset.id], () => {
      if (next) selectVersion(next.asset.id)
      else onClose()
    })
  }
  const compare = before !== undefined && !isVideo && before.asset.kind === 'image'

  return (
    <div className="ed" data-mantine-color-scheme="dark" data-testid="studio-editor">
      <div className="ed-strip" data-testid="studio-ed-strip">
        {versions.map((v, i) => (
          <button
            key={v.asset.id}
            type="button"
            className={`ed-thumb${v.asset.id === sel ? ' on' : ''}`}
            onClick={() => selectVersion(v.asset.id)}
            aria-label={i === 0 ? 'Original' : `Version ${i + 1}`}
            aria-current={v.asset.id === sel}
            data-testid="studio-ed-version"
            data-id={v.asset.id}
            data-on={v.asset.id === sel}
          >
            <img src={mediaSrc(v.asset.thumb)} alt="" />
            {v.asset.kind === 'video' ? (
              <span className="ed-play">
                <IconPlayerPlayFilled size={10} />
              </span>
            ) : null}
          </button>
        ))}
        {pending.map((j) => {
          const from = lib.lineage.byId.get(j.parent?.asset ?? '')
          return (
            <button
              key={j.id}
              type="button"
              className={`ed-thumb pending${j.id === viewing ? ' on' : ''}`}
              onClick={() => viewPending(j)}
              aria-label="Generating"
              aria-current={j.id === viewing}
              data-testid="studio-ed-pending"
              data-job={j.id}
              data-on={j.id === viewing}
            >
              {from ? <img src={mediaSrc(from.asset.thumb)} alt="" /> : null}
              <span className="ed-spin" />
            </button>
          )
        })}
      </div>

      <div className="ed-center">
        <div className="ed-top">
          <Tooltip label="Back to grid">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={onClose}
              aria-label="Back to grid"
              data-testid="studio-ed-back"
            >
              <IconArrowLeft size={18} />
            </ActionIcon>
          </Tooltip>
          <ActionIcon
            variant="subtle"
            color="gray"
            disabled={vi <= 0}
            onClick={() => go(-1)}
            aria-label="Previous version"
            data-testid="studio-ed-prev"
          >
            <IconChevronLeft size={18} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="gray"
            disabled={vi >= versions.length - 1}
            onClick={() => go(1)}
            aria-label="Next version"
            data-testid="studio-ed-next"
          >
            <IconChevronRight size={18} />
          </ActionIcon>
          <div className="ed-zoom">
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label="Zoom out"
              disabled={zoom <= MIN_ZOOM}
              onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP))}
              data-testid="studio-ed-zoom-out"
            >
              <IconMinus size={14} />
            </ActionIcon>
            <span data-testid="studio-ed-zoom">{Math.round(fit * zoom * 100)}%</span>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label="Zoom in"
              disabled={zoom >= MAX_ZOOM}
              onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP))}
              data-testid="studio-ed-zoom-in"
            >
              <IconPlus size={14} />
            </ActionIcon>
          </div>
          <Tooltip label={compare ? 'Hold to see the parent version (Space)' : 'No parent version'}>
            <ActionIcon
              variant={hold ? 'light' : 'subtle'}
              color="gray"
              disabled={!compare}
              aria-label="Compare with parent"
              onPointerDown={() => setHold(true)}
              onPointerUp={() => setHold(false)}
              onPointerLeave={() => setHold(false)}
              data-testid="studio-ed-compare"
            >
              <IconSwitchHorizontal size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={split ? 'Exit split compare' : 'Split compare'}>
            <ActionIcon
              variant={split ? 'light' : 'subtle'}
              color="gray"
              disabled={!compare}
              aria-label="Split compare"
              aria-pressed={split}
              onClick={() => setSplit((v) => !v)}
              data-testid="studio-ed-split-toggle"
            >
              <IconLayoutColumns size={18} />
            </ActionIcon>
          </Tooltip>
          <div className="ed-grow" />
          <QueueIndicator />
          <Tooltip label={panel ? 'Hide panel' : 'Show panel'}>
            <ActionIcon
              variant={panel ? 'light' : 'subtle'}
              color="gray"
              aria-label={panel ? 'Hide panel' : 'Show panel'}
              onClick={() => setPanel((v) => !v)}
              data-testid="studio-ed-panel-toggle"
            >
              <IconLayoutSidebarRight size={18} />
            </ActionIcon>
          </Tooltip>
        </div>

        <EditorCanvas
          cur={cur}
          before={compare ? before : undefined}
          hold={hold}
          split={split}
          zoom={zoom}
          onFit={setFit}
          pending={viewingJob}
          onCancel={(id) => void cancelJob(id)}
          segment={picked}
          crop={crop}
          onCrop={setCrop}
        />

        <EditorBar
          input={input}
          prompt={prompt}
          onPrompt={setPrompt}
          engine={engine}
          onEngine={setEngine}
          refs={refs}
          onRefs={setRefs}
          picking={picking}
          onPicking={setPicking}
          images={versions
            .filter((v) => v.asset.id !== sel && v.asset.kind === 'image')
            .map((v) => ({ id: v.asset.id, thumb: v.asset.thumb }))}
          segment={picked}
          onClearSegment={() => setSegment(null)}
          locked={isVideo ? 'Pick an image version to edit' : undefined}
          busy={busy}
          onSend={send}
        />
      </div>

      {panel ? (
        <EditorPanel
          cur={cur}
          versions={versions}
          backends={lib.backends}
          prompt={prompt}
          segments={segments}
          segmentError={segmentErrors[sel]}
          onRetrySegments={() => askSegments(sel)}
          selectedSegment={picked?.id ?? null}
          onSelectSegment={setSegment}
          busy={busy}
          onRun={run}
          onCombine={() => {
            setPrompt((t) => (t === '' || t.endsWith(' ') ? `${t}@` : `${t} @`))
            setPicking(true)
            input.current?.focus()
          }}
          cropping={crop !== null}
          onCropStart={() => {
            setSplit(false)
            setCrop(START_CROP)
          }}
          onCropDone={() => crop && run(cropRecipe(cur, lib.backends, clampCrop(crop)))}
          onCropCancel={() => setCrop(null)}
          onDelete={remove}
        />
      ) : null}
    </div>
  )
}
