import {
  memo,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Tooltip } from '@mantine/core'
import {
  IconArrowsShuffle,
  IconCheck,
  IconChevronDown,
  IconDots,
  IconGitBranch,
  IconHeart,
  IconHeartFilled,
  IconMovie,
  IconPhotoOff,
  IconPlayerPlayFilled,
  IconSearch,
  IconSquareCheck,
  IconSquareCheckFilled,
  IconX,
} from '@tabler/icons-react'
import {
  STUDIO_UNSORTED,
  studioEtaLabel,
  studioRemixSpec,
  studioResolutions,
  studioSeconds,
  type StudioItem,
  type StudioJob,
  type StudioProject,
} from '@evaos/contract'
import { EvaMenu } from '../../overlay'
import { durationLabel } from '../studio-assets'
import { studioStore } from '../studio-store'
import {
  cancelJob,
  createJobs,
  deleteProjectModal,
  favoriteAssets,
  mediaSrc,
  projectName,
  renameProjectModal,
  toast,
  useLibrary,
} from './actions'
import { engineKey, engineLabel } from './create-models'
import { clickSelection, filtering, studioGrid, type Grid } from './grid'
import { DRAG_TYPE } from './Rail'
import { QueueIndicator } from './menus'
import {
  FILTERS,
  localStore,
  setSelected,
  useLocal,
  VIEW_ALL,
  VIEW_FAV,
  type DateFilter,
} from './local'

/** The open view's grid with the filters applied. */
export function useGrid(): Grid {
  const { items, lineage, jobs } = useLibrary()
  const view = useLocal((s) => s.view)
  const query = useLocal((s) => s.query)
  const models = useLocal((s) => s.models)
  const favOnly = useLocal((s) => s.favOnly)
  const date = useLocal((s) => s.date)
  return useMemo(
    () => studioGrid(view, items, lineage, jobs, { query, models, favOnly, date }),
    [view, items, lineage, jobs, query, models, favOnly, date],
  )
}

function viewTitle(view: string, projects: readonly StudioProject[]): string {
  if (view === VIEW_ALL) return 'All images'
  if (view === VIEW_FAV) return 'Favorites'
  return projectName(view, projects)
}

function ProjectActions({ id }: { id: string }) {
  const [opened, setOpened] = useState(false)
  if (id === VIEW_ALL || id === VIEW_FAV || id === STUDIO_UNSORTED) return null
  return (
    <EvaMenu opened={opened} onChange={setOpened} position="bottom-start" width={190}>
      <EvaMenu.Target>
        <button
          type="button"
          className="sl-quiet sl-icon"
          aria-label="Project actions"
          onClick={() => setOpened((o) => !o)}
        >
          <IconDots size={16} />
        </button>
      </EvaMenu.Target>
      <EvaMenu.Dropdown>
        <EvaMenu.Item onClick={() => renameProjectModal(id)}>Rename project</EvaMenu.Item>
        <EvaMenu.Item color="red" onClick={() => deleteProjectModal(id)}>
          Delete project
        </EvaMenu.Item>
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}

export function Header({ total }: { total: number }) {
  const view = useLocal((s) => s.view)
  const selecting = useLocal((s) => s.selectMode || s.selected.length > 0)
  const { projects } = useLibrary()
  return (
    <header className="sl-head">
      <h2 data-testid="studio-view-title">{viewTitle(view, projects)}</h2>
      <span className="sl-dim" data-testid="studio-count">
        {total} {total === 1 ? 'image' : 'images'}
      </span>
      <ProjectActions id={view} />
      <span className="sl-grow" />
      <QueueIndicator />
      <button
        type="button"
        className={`sl-quiet${selecting ? ' on' : ''}`}
        data-testid="studio-select"
        onClick={() =>
          selecting
            ? localStore.setState({ selectMode: false, selected: [], anchor: null })
            : localStore.setState({ selectMode: true })
        }
      >
        {selecting ? <IconSquareCheckFilled size={16} /> : <IconSquareCheck size={16} />}
        {selecting ? 'Done' : 'Select'}
      </button>
    </header>
  )
}

const DATES: { id: DateFilter; label: string }[] = [
  { id: 'all', label: 'Any time' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
]

export function Filters() {
  const query = useLocal((s) => s.query)
  const models = useLocal((s) => s.models)
  const favOnly = useLocal((s) => s.favOnly)
  const date = useLocal((s) => s.date)
  const { items, backends } = useLibrary()
  const [modelOpen, setModelOpen] = useState(false)
  const [dateOpen, setDateOpen] = useState(false)
  const used = useMemo(() => {
    const seen = new Map<string, string>()
    for (const i of items) {
      const key = engineKey(i.job.spec)
      if (!seen.has(key)) seen.set(key, engineLabel(i.job.spec, backends))
    }
    return [...seen].map(([key, label]) => ({ key, label }))
  }, [items, backends])
  const modelLabel =
    models.length === 0
      ? 'Model'
      : models.length === 1
        ? (used.find((u) => u.key === models[0])?.label ?? '1 model')
        : `${models.length} models`
  const active = filtering({ query, models, favOnly, date })
  return (
    <div className="sl-filters" role="search">
      <label className="sl-search">
        <IconSearch size={15} />
        <input
          value={query}
          onChange={(e) => localStore.setState({ query: e.currentTarget.value })}
          placeholder="Search prompts"
          aria-label="Search prompts"
          data-testid="studio-search"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => localStore.setState({ query: '' })}
          >
            <IconX size={13} />
          </button>
        ) : null}
      </label>
      <EvaMenu
        opened={modelOpen}
        onChange={setModelOpen}
        position="bottom-start"
        closeOnItemClick={false}
        width={220}
      >
        <EvaMenu.Target>
          <button
            type="button"
            className={`sl-chip${models.length ? ' on' : ''}`}
            data-testid="studio-filter-model"
            onClick={() => setModelOpen((o) => !o)}
          >
            {modelLabel}
            <IconChevronDown size={13} />
          </button>
        </EvaMenu.Target>
        <EvaMenu.Dropdown>
          {used.length === 0 ? <EvaMenu.Label>No images yet</EvaMenu.Label> : null}
          {used.map((m) => (
            <EvaMenu.Item
              key={m.key}
              rightSection={models.includes(m.key) ? <IconCheck size={14} /> : null}
              onClick={() =>
                localStore.setState({
                  models: models.includes(m.key)
                    ? models.filter((x) => x !== m.key)
                    : [...models, m.key],
                })
              }
            >
              {m.label}
            </EvaMenu.Item>
          ))}
        </EvaMenu.Dropdown>
      </EvaMenu>
      <button
        type="button"
        className={`sl-chip${favOnly ? ' on' : ''}`}
        aria-pressed={favOnly}
        data-testid="studio-filter-fav"
        onClick={() => localStore.setState({ favOnly: !favOnly })}
      >
        {favOnly ? <IconHeartFilled size={13} /> : <IconHeart size={13} />} Favorites
      </button>
      <EvaMenu opened={dateOpen} onChange={setDateOpen} position="bottom-start" width={150}>
        <EvaMenu.Target>
          <button
            type="button"
            className={`sl-chip${date !== 'all' ? ' on' : ''}`}
            data-testid="studio-filter-date"
            onClick={() => setDateOpen((o) => !o)}
          >
            {DATES.find((d) => d.id === date)?.label}
            <IconChevronDown size={13} />
          </button>
        </EvaMenu.Target>
        <EvaMenu.Dropdown>
          {DATES.map((d) => (
            <EvaMenu.Item
              key={d.id}
              rightSection={d.id === date ? <IconCheck size={14} /> : null}
              onClick={() => localStore.setState({ date: d.id })}
            >
              {d.label}
            </EvaMenu.Item>
          ))}
        </EvaMenu.Dropdown>
      </EvaMenu>
      {active ? (
        <button type="button" className="sl-clear" onClick={() => localStore.setState(FILTERS)}>
          Clear filters
        </button>
      ) : null}
    </div>
  )
}

/** Two more takes of an image's prompt on its own engine, new seeds, as its children. */
async function vary(item: StudioItem): Promise<void> {
  const { seed: _seed, ...spec } = studioRemixSpec(item.job)
  const a = await createJobs({
    spec,
    count: 2,
    ...(item.job.project === undefined ? {} : { project: item.job.project }),
    parent: { asset: item.asset.id, how: 'vary' },
  })
  if (a.ok) toast('Queued 2 variations', undefined, 2500)
}

/** A video from the image (LTX, its first length), as its child. */
async function video(item: StudioItem): Promise<void> {
  const { backends } = studioStore.getState().view
  const ltx = backends.find((b) => b.id === 'ltx')
  if (!ltx) {
    toast('This Relay host has no LTX video', undefined, 4000)
    return
  }
  const { width, height } = item.asset
  const aspect = width / height > 1.2 ? '16:9' : width / height < 0.83 ? '9:16' : '1:1'
  const resolution = studioResolutions(ltx, aspect)[0]?.id
  if (resolution === undefined) {
    toast(`LTX has no ${aspect} size`, undefined, 4000)
    return
  }
  const a = await createJobs({
    spec: {
      mode: 'video',
      backend: 'ltx',
      prompt: 'Subtle natural motion',
      aspect,
      resolution,
      seconds: studioSeconds(ltx).includes(4) ? 4 : studioSeconds(ltx)[0],
      frames: { start: item.asset.id },
    },
    ...(item.job.project === undefined ? {} : { project: item.job.project }),
    parent: { asset: item.asset.id, how: 'video' },
  })
  if (a.ok) toast('Queued a video', undefined, 2500)
}

const Tile = memo(function Tile({
  item,
  order,
  count,
  onOpen,
}: {
  item: StudioItem
  order: readonly string[]
  count: number
  onOpen: (id: string) => void
}) {
  const id = item.asset.id
  const selected = useLocal((s) => s.selected.includes(id))
  const selecting = useLocal((s) => s.selected.length > 0 || s.selectMode)
  const fav = item.asset.favorite === true
  const isVideo = item.asset.kind === 'video'
  const click = (e: MouseEvent): void => {
    const next = clickSelection(e, id, order, localStore.getState())
    if (next === 'open') onOpen(id)
    else setSelected(next.selected, next.anchor)
  }
  const toggle = (e: MouseEvent): void => {
    e.stopPropagation()
    const s = localStore.getState()
    setSelected(
      s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id],
      id,
    )
  }
  return (
    <div
      className={`sl-tile${selected ? ' is-selected' : ''}${selecting ? ' selecting' : ''}`}
      data-testid="studio-tile"
      data-id={id}
      data-asset={id}
      data-selected={selected ? 'true' : undefined}
      role="button"
      tabIndex={0}
      aria-label={item.job.spec.prompt}
      draggable
      onClick={click}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(id)
      }}
      onDragStart={(e) => {
        const s = localStore.getState()
        const ids = s.selected.includes(id) ? s.selected : [id]
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids))
        e.dataTransfer.effectAllowed = 'move'
        if (ids.length > 1) {
          const ghost = document.createElement('div')
          ghost.textContent = `${ids.length} images`
          ghost.className = 'sl-drag-ghost'
          document.body.appendChild(ghost)
          e.dataTransfer.setDragImage(ghost, 12, 12)
          setTimeout(() => ghost.remove(), 0)
        }
        localStore.setState({ dragging: true })
      }}
      onDragEnd={() => localStore.setState({ dragging: false })}
    >
      <img src={mediaSrc(item.asset.thumb)} alt="" loading="lazy" draggable={false} />
      {isVideo ? (
        <span className="sl-tile-badge">
          <IconPlayerPlayFilled size={10} />{' '}
          {item.asset.durationMs === undefined ? '' : durationLabel(item.asset.durationMs)}
        </span>
      ) : null}
      <button
        type="button"
        className={`sl-tile-check${selected ? ' on' : ''}`}
        aria-label={selected ? 'Deselect' : 'Select'}
        data-testid="studio-tile-check"
        onClick={toggle}
      >
        {selected ? <IconCheck size={13} stroke={3} /> : null}
      </button>
      {fav && !selecting ? (
        <IconHeartFilled className="sl-tile-fav" size={16} data-testid="studio-tile-fav" />
      ) : null}
      {count > 0 ? (
        <span
          className="sl-tile-count"
          title={`${count} ${count === 1 ? 'iteration' : 'iterations'}`}
          data-testid="studio-tile-count"
        >
          <IconGitBranch size={11} /> {count}
        </span>
      ) : null}
      <span className="sl-ppill">{item.job.spec.prompt}</span>
      {!selecting ? (
        <div className="sl-tile-hover">
          <div className="sl-tile-hover-row">
            {!isVideo ? (
              <Tooltip label="Two variations" openDelay={400}>
                <button
                  type="button"
                  className="sl-tile-act"
                  onClick={(e) => {
                    e.stopPropagation()
                    void vary(item)
                  }}
                >
                  <IconArrowsShuffle size={13} /> Vary
                </button>
              </Tooltip>
            ) : null}
            {!isVideo ? (
              <Tooltip label="Make a video" openDelay={400}>
                <button
                  type="button"
                  className="sl-tile-act"
                  onClick={(e) => {
                    e.stopPropagation()
                    void video(item)
                  }}
                >
                  <IconMovie size={13} /> Video
                </button>
              </Tooltip>
            ) : null}
            <button
              type="button"
              className="sl-tile-act sl-icon sl-push"
              aria-label={fav ? 'Unfavorite' : 'Favorite'}
              data-testid="studio-tile-heart"
              onClick={(e) => {
                e.stopPropagation()
                void favoriteAssets([id], !fav)
              }}
            >
              {fav ? <IconHeartFilled size={14} /> : <IconHeart size={14} />}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
})

function PendingTile({ job }: { job: StudioJob }) {
  const running = job.state === 'running'
  const pct = running ? Math.min(0.99, job.progress) : 0
  return (
    <div className="sl-tile pending" data-testid="studio-pending" data-job={job.id}>
      <div className="sl-shimmer" />
      <div className="sl-pending-text">
        {running ? (
          <>
            <b>{Math.round(pct * 100)}%</b>
            {job.note ? <span className="sl-dim">{job.note}</span> : null}
            <span className="sl-dim">{studioEtaLabel(job.etaMs) ?? ''}</span>
          </>
        ) : (
          <>
            <b>Queued</b>
            <span className="sl-dim">{job.note ?? 'Waiting for the GPU'}</span>
          </>
        )}
      </div>
      <button
        type="button"
        className="sl-cancel"
        aria-label="Cancel"
        title="Cancel"
        data-testid="studio-pending-cancel"
        onClick={() => void cancelJob(job.id)}
      >
        <IconX size={12} />
      </button>
      <div className="sl-pending-bar">
        <div style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  )
}

/** Marquee drag-select on the grid's empty space. */
function useMarquee() {
  const scroller = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; y: number; base: string[]; active: boolean } | null>(null)
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const down = (e: ReactPointerEvent): void => {
    if (e.button !== 0 || e.pointerType !== 'mouse') return
    if ((e.target as HTMLElement).closest('.sl-tile, button, a, input, textarea, [role=button]'))
      return
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    start.current = {
      x: e.clientX,
      y: e.clientY,
      base: additive ? localStore.getState().selected : [],
      active: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: ReactPointerEvent): void => {
    const s = start.current
    const el = scroller.current
    if (!s || !el) return
    if (!s.active && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 4) return
    s.active = true
    const r = el.getBoundingClientRect()
    if (e.clientY < r.top + 36) el.scrollTop -= 14
    else if (e.clientY > r.bottom - 36) el.scrollTop += 14
    const x1 = Math.min(s.x, e.clientX)
    const x2 = Math.max(s.x, e.clientX)
    const y1 = Math.min(s.y, e.clientY)
    const y2 = Math.max(s.y, e.clientY)
    setBox({ x: x1 - r.left + el.scrollLeft, y: y1 - r.top + el.scrollTop, w: x2 - x1, h: y2 - y1 })
    const hits: string[] = []
    for (const n of el.querySelectorAll<HTMLElement>('[data-asset]')) {
      const b = n.getBoundingClientRect()
      if (b.right > x1 && b.left < x2 && b.bottom > y1 && b.top < y2 && n.dataset.asset) {
        hits.push(n.dataset.asset)
      }
    }
    setSelected([...new Set([...s.base, ...hits])], hits[0] ?? null)
  }
  const up = (): void => {
    const s = start.current
    start.current = null
    setBox(null)
    if (s && !s.active && s.base.length === 0) setSelected([])
  }
  const overlay = box ? (
    <div
      className="sl-marquee"
      data-testid="studio-marquee"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    />
  ) : null
  return {
    scroller,
    handlers: { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up },
    overlay,
  }
}

function Empty({ fav }: { fav: boolean }) {
  return (
    <div className="sl-empty" data-testid="studio-empty">
      <IconPhotoOff size={28} stroke={1.4} />
      <b>{fav ? 'No favorites yet' : 'Nothing here yet'}</b>
      {fav
        ? 'Tap the heart on an image to keep it here.'
        : 'Write a prompt below and press Generate, or drag images in from another project.'}
    </div>
  )
}

/** The grid of originals: pending ones first, then images newest first. */
export function Feed({ grid, onOpen }: { grid: Grid; onOpen: (id: string) => void }) {
  const view = useLocal((s) => s.view)
  const m = useMarquee()
  return (
    <div className="sl-feed" ref={m.scroller} data-testid="studio-feed" {...m.handlers}>
      {grid.items.length === 0 && grid.pending.length === 0 ? (
        <Empty fav={view === VIEW_FAV} />
      ) : (
        <div className="sl-grid">
          {grid.pending.map((j) => (
            <PendingTile key={j.id} job={j} />
          ))}
          {grid.items.map((i) => (
            <Tile
              key={i.asset.id}
              item={i}
              order={grid.order}
              count={grid.counts.get(i.asset.id) ?? 0}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
      {m.overlay}
    </div>
  )
}
