import { useState, type DragEvent, type ReactNode } from 'react'
import {
  IconDots,
  IconFolder,
  IconHeart,
  IconInbox,
  IconPalette,
  IconPhoto,
  IconPlus,
  IconUser,
  IconX,
} from '@tabler/icons-react'
import {
  STUDIO_UNSORTED,
  studioEtaLabel,
  studioJobActive,
  type StudioReferenceKind,
} from '@evaos/contract'
import { EvaMenu } from '../../overlay'
import { useStudio } from '../studio-store'
import {
  deleteProjectModal,
  deleteReference,
  favoriteAssets,
  mediaSrc,
  moveAssets,
  newProjectModal,
  renameProjectModal,
  saveReferenceModal,
  toast,
  useLibrary,
} from './actions'
import { railCounts } from './grid'
import { localStore, openView, setComposer, useLocal, VIEW_ALL, VIEW_FAV } from './local'

/** The MIME type a dragged tile carries: the asset ids it moves, as JSON. */
export const DRAG_TYPE = 'application/x-studio-assets'

/** Drop handlers for a rail row: a project takes a move, Favorites a favorite. */
function useDropTarget(target: string) {
  const [over, setOver] = useState(false)
  const takes = (e: DragEvent): boolean => e.dataTransfer.types.includes(DRAG_TYPE)
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!takes(e) || target === VIEW_ALL) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      },
      onDragEnter: (e: DragEvent) => {
        if (takes(e) && target !== VIEW_ALL) setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        e.preventDefault()
        setOver(false)
        localStore.setState({ dragging: false })
        const raw = e.dataTransfer.getData(DRAG_TYPE)
        if (!raw) return
        const ids = JSON.parse(raw) as string[]
        if (target === VIEW_FAV) void favoriteAssets(ids, true)
        else if (target !== VIEW_ALL) void moveAssets(ids, target)
      },
    },
  }
}

function RailItem({
  id,
  icon,
  label,
  count,
  cover,
  menu,
}: {
  id: string
  icon: ReactNode
  label: string
  count: number
  cover?: string
  menu?: ReactNode
}) {
  const on = useLocal((s) => s.view === id)
  const { over, props } = useDropTarget(id)
  return (
    <div
      role="button"
      tabIndex={0}
      className={`sl-rail-item${on ? ' on' : ''}${over ? ' over' : ''}`}
      data-testid={`studio-rail-${id}`}
      aria-current={on ? 'page' : undefined}
      onClick={() => openView(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') openView(id)
      }}
      {...props}
    >
      {cover ? <img className="sl-rail-cover" src={mediaSrc(cover)} alt="" /> : icon}
      <span className="sl-name">{label}</span>
      <span className={`sl-n${menu ? ' hasmore' : ''}`}>{count}</span>
      {menu}
    </div>
  )
}

function ProjectMenu({ id, name }: { id: string; name: string }) {
  const [opened, setOpened] = useState(false)
  return (
    <EvaMenu opened={opened} onChange={setOpened} position="right-start" width={170}>
      <EvaMenu.Target>
        <span
          role="button"
          tabIndex={0}
          className="sl-more"
          aria-label={`${name} menu`}
          onClick={(e) => {
            e.stopPropagation()
            setOpened((o) => !o)
          }}
        >
          <IconDots size={15} />
        </span>
      </EvaMenu.Target>
      <EvaMenu.Dropdown>
        <EvaMenu.Item onClick={() => renameProjectModal(id)}>Rename</EvaMenu.Item>
        <EvaMenu.Item color="red" onClick={() => deleteProjectModal(id)}>
          Delete project
        </EvaMenu.Item>
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}

/** The image a reference is saved from: the one open in the editor, else the first selected. */
function currentImage(): string | null {
  const { editing, selected } = localStore.getState()
  return editing ?? selected[0] ?? null
}

function SaveReferenceMenu() {
  const [opened, setOpened] = useState(false)
  const save = (kind: StudioReferenceKind) => saveReferenceModal(currentImage(), kind)
  return (
    <EvaMenu opened={opened} onChange={setOpened} position="right-start" width={250}>
      <EvaMenu.Target>
        <button type="button" aria-label="Save a reference" onClick={() => setOpened((o) => !o)}>
          <IconPlus size={15} />
        </button>
      </EvaMenu.Target>
      <EvaMenu.Dropdown>
        <EvaMenu.Item leftSection={<IconPalette size={15} />} onClick={() => save('style')}>
          Save current version as style
        </EvaMenu.Item>
        <EvaMenu.Item leftSection={<IconUser size={15} />} onClick={() => save('character')}>
          Save current version as character
        </EvaMenu.Item>
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}

function References() {
  const references = useStudio((s) => s.view.references)
  const picked = useLocal((s) => s.composer.refs)
  const groups = [
    { kind: 'style' as const, label: 'Styles' },
    { kind: 'character' as const, label: 'Characters' },
  ]
  return (
    <>
      <div className="sl-rail-section">
        <span>References</span>
        <SaveReferenceMenu />
      </div>
      <div className="sl-rail-list">
        {groups.map((g) => {
          const list = references.filter((r) => r.kind === g.kind)
          return (
            <div key={g.kind} data-testid={`studio-refs-${g.kind}`}>
              <div className="sl-rail-sub">{g.label}</div>
              {list.length === 0 ? <div className="sl-rail-none">None yet</div> : null}
              {list.map((r) => (
                <div
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  className={`sl-rail-item${picked.includes(r.asset.id) ? ' on' : ''}`}
                  title="Add to the prompt bar"
                  data-testid="studio-reference"
                  onClick={() => {
                    const { refs } = localStore.getState().composer
                    if (refs.includes(r.asset.id)) return
                    setComposer({ refs: [...refs, r.asset.id] })
                    toast(`${r.name} added to the prompt bar`, undefined, 2000)
                  }}
                >
                  <img className="sl-rail-cover" src={mediaSrc(r.asset.thumb)} alt="" />
                  <span className="sl-name">{r.name}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="sl-more"
                    aria-label={`Delete ${r.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void deleteReference(r)
                    }}
                  >
                    <IconX size={14} />
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </>
  )
}

/** Studio's left rail: All images, Favorites, Projects (with Unsorted), References, the GPU line. */
export function Rail() {
  const { items, lineage, projects, jobs } = useLibrary()
  const counts = railCounts(items, lineage)
  const active = jobs.filter(studioJobActive)
  const running = active.filter((j) => j.state === 'running').length
  const waiting = active.length - running
  const eta = studioEtaLabel(Math.max(0, ...active.map((j) => j.etaMs ?? 0)))
  return (
    <aside className="sl-rail" aria-label="Projects">
      <div className="sl-rail-head">
        <h1 data-page-title>Studio</h1>
      </div>
      <div className="sl-rail-list">
        <RailItem
          id={VIEW_ALL}
          icon={<IconPhoto size={17} />}
          label="All images"
          count={counts.all}
        />
        <RailItem
          id={VIEW_FAV}
          icon={<IconHeart size={17} />}
          label="Favorites"
          count={counts.fav}
        />
      </div>
      <div className="sl-rail-section">
        <span>Projects</span>
        <button type="button" aria-label="New project" onClick={() => newProjectModal(openView)}>
          <IconPlus size={15} />
        </button>
      </div>
      <div className="sl-rail-list">
        {projects.map((p) => (
          <RailItem
            key={p.id}
            id={p.id}
            icon={<IconFolder size={17} />}
            cover={counts.cover.get(p.id)}
            label={p.name}
            count={counts.by.get(p.id) ?? 0}
            menu={<ProjectMenu id={p.id} name={p.name} />}
          />
        ))}
        <RailItem
          id={STUDIO_UNSORTED}
          icon={<IconInbox size={17} />}
          label="Unsorted"
          count={counts.by.get(STUDIO_UNSORTED) ?? 0}
        />
      </div>
      <References />
      <div className="sl-rail-foot">
        <div className={`sl-rail-gpu${active.length ? ' busy' : ''}`}>
          <span className="sl-dot" />
          {active.length ? (
            <span>
              GPU busy: {running} running{waiting ? `, ${waiting} waiting` : ''}
              {eta ? <br /> : null}
              {eta}
            </span>
          ) : (
            <span>GPU idle</span>
          )}
        </div>
      </div>
    </aside>
  )
}
