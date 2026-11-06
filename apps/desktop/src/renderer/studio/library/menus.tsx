// Menus shared by the landing and the editor: Move to, Send to chat, Add to canvas, the GPU queue,
// and the @ picker with its chips.
import { useMemo, useState, type ReactElement } from 'react'
import {
  IconCheck,
  IconCpu,
  IconFolder,
  IconInbox,
  IconLayoutBoard,
  IconMessage,
  IconPalette,
  IconPhoto,
  IconPlus,
  IconUser,
  IconX,
} from '@tabler/icons-react'
import {
  STUDIO_UNSORTED,
  studioEtaLabel,
  studioItems,
  studioJobActive,
  type StudioReference,
} from '@evaos/contract'
import { placeOf, type Place } from '@evaos/shell-core'
import { useAssistants } from '../../assistants/assistants-store'
import { canvasStore, loadCanvasList, useCanvasList } from '../../canvas/canvas-store'
import { fillComposerImages } from '../../chat/composer-fill'
import { MAX_PROMPT_IMAGES, readImageFiles } from '../../chat/composer/image-input'
import { listStore, useListStore } from '../../chat/list/list-store'
import { invoke } from '../../ipc'
import { openInApp } from '../../navigation/open-in-app'
import { EvaMenu, EvaPopover } from '../../overlay'
import { downloadName } from '../studio-assets'
import { studioStore, useStudio } from '../studio-store'
import { engineLabel } from './create-models'
import {
  cancelJob,
  mediaSrc,
  moveAssets,
  newProjectModal,
  plural,
  toast,
  useLibrary,
} from './actions'

const RECENT_CHATS = 6

/** Move images to Unsorted or a project (or a new one). */
export function MoveMenu({
  ids,
  current,
  trigger,
  onDone,
}: {
  ids: string[]
  current?: string
  trigger: ReactElement
  onDone?: () => void
}) {
  const [opened, setOpened] = useState(false)
  const projects = useStudio((s) => s.view.projects)
  const move = (project: string): void => {
    void moveAssets(ids, project).then(() => onDone?.())
  }
  const check = (id: string) => (current === id ? <IconCheck size={14} /> : null)
  return (
    <EvaMenu opened={opened} onChange={setOpened} position="top" width={230}>
      <EvaMenu.Target>{trigger}</EvaMenu.Target>
      <EvaMenu.Dropdown data-testid="studio-move-menu">
        <EvaMenu.Label>Move to</EvaMenu.Label>
        <EvaMenu.Item
          leftSection={<IconInbox size={15} />}
          rightSection={check(STUDIO_UNSORTED)}
          onClick={() => move(STUDIO_UNSORTED)}
        >
          Unsorted
        </EvaMenu.Item>
        {projects.map((p) => (
          <EvaMenu.Item
            key={p.id}
            leftSection={<IconFolder size={15} />}
            rightSection={check(p.id)}
            onClick={() => move(p.id)}
          >
            {p.name}
          </EvaMenu.Item>
        ))}
        <EvaMenu.Divider />
        <EvaMenu.Item leftSection={<IconPlus size={15} />} onClick={() => newProjectModal(move)}>
          New project
        </EvaMenu.Item>
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}

interface ChatTarget {
  key: string
  name: string
  /** The chat's session file: the composer of the pane showing it takes the images. */
  file: string
  place: Place
}

/** Images of `ids` as files, read the way the chat composer reads a drop. */
async function imageFiles(ids: readonly string[]): Promise<File[]> {
  const byId = new Map(
    studioItems(studioStore.getState().view.jobs).map((i) => [i.asset.id, i.asset]),
  )
  const assets = ids.flatMap((id) => {
    const a = byId.get(id)
    return a && a.kind === 'image' ? [a] : []
  })
  return Promise.all(
    assets.map(async (a) => {
      const res = await fetch(mediaSrc(a.path))
      if (!res.ok) throw new Error(`Relay answered ${res.status}`)
      const blob = await res.blob()
      return new File([blob], downloadName(a), { type: blob.type || a.mimeType })
    }),
  )
}

/** Attaches the images to a chat's composer (an assistant's thread or a recent chat) and opens it. */
export function SendToChat({ ids, trigger }: { ids: string[]; trigger: ReactElement }) {
  const [opened, setOpened] = useState(false)
  const agents = useAssistants((s) => s.data?.agents ?? null)
  const rows = useListStore((s) => s.list?.rows ?? null)
  const targets = useMemo(() => {
    const assistants: ChatTarget[] = (agents ?? []).flatMap((a) =>
      a.file === null
        ? []
        : [{ key: `agent:${a.id}`, name: a.title, file: a.file, place: placeOf(`agent:${a.id}`) }],
    )
    const taken = new Set(assistants.map((a) => a.file))
    const recent: ChatTarget[] = (rows ?? [])
      .filter((r) => !r.archived && !taken.has(r.file))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, RECENT_CHATS)
      .map((r) => ({
        key: r.id,
        name: r.title || 'Chat',
        file: r.file,
        place: placeOf('chat', { chat: r.file }),
      }))
    return { assistants, recent }
  }, [agents, rows])
  const open = (next: boolean): void => {
    setOpened(next)
    if (next && listStore.getState().list === null) void listStore.getState().load()
  }
  const send = async (t: ChatTarget): Promise<void> => {
    try {
      const files = await imageFiles(ids)
      if (files.length === 0) {
        toast('Only images can go to a chat', undefined, 3000)
        return
      }
      const read = await readImageFiles(files, MAX_PROMPT_IMAGES)
      fillComposerImages(t.file, read.images)
      openInApp(t.place, 'here')
      const extra = files.length > read.images.length ? `, ${MAX_PROMPT_IMAGES} at most` : ''
      toast(`Attached ${plural(read.images.length, 'image')} to ${t.name}${extra}`, undefined, 3000)
    } catch (e) {
      toast(
        `Couldn't attach the images: ${e instanceof Error ? e.message : String(e)}`,
        undefined,
        8000,
      )
    }
  }
  const none = targets.assistants.length === 0 && targets.recent.length === 0
  return (
    <EvaMenu opened={opened} onChange={open} position="top" width={260}>
      <EvaMenu.Target>{trigger}</EvaMenu.Target>
      <EvaMenu.Dropdown data-testid="studio-send-menu">
        {targets.assistants.length > 0 ? <EvaMenu.Label>Assistants</EvaMenu.Label> : null}
        {targets.assistants.map((t) => (
          <EvaMenu.Item
            key={t.key}
            leftSection={<IconUser size={15} />}
            onClick={() => void send(t)}
          >
            {t.name}
          </EvaMenu.Item>
        ))}
        {targets.recent.length > 0 ? <EvaMenu.Label>Recent chats</EvaMenu.Label> : null}
        {targets.recent.map((t) => (
          <EvaMenu.Item
            key={t.key}
            leftSection={<IconMessage size={15} />}
            onClick={() => void send(t)}
          >
            {t.name}
          </EvaMenu.Item>
        ))}
        {none ? <EvaMenu.Label>No chats yet</EvaMenu.Label> : null}
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}

/** Copies the images onto a Canvas board (an existing one or a new one). */
export function AddToCanvas({ ids, trigger }: { ids: string[]; trigger: ReactElement }) {
  const [opened, setOpened] = useState(false)
  const entries = useCanvasList((s) => s.entries)
  const open = (next: boolean): void => {
    setOpened(next)
    if (next) void loadCanvasList()
  }
  const add = async (slug: string | null): Promise<void> => {
    let board = slug
    if (board === null) {
      const made = await invoke('canvas.create', {})
      if (!made.ok) {
        toast(`Couldn't make a board: ${made.error.message}`, undefined, 8000)
        return
      }
      board = made.value.slug
    }
    const byId = new Map(
      studioItems(studioStore.getState().view.jobs).map((i) => [i.asset.id, i.asset]),
    )
    const assets = ids.flatMap((id) => {
      const a = byId.get(id)
      return a && a.kind === 'image' ? [{ path: a.path, name: downloadName(a) }] : []
    })
    if (assets.length === 0) {
      toast('Only images can go on a board', undefined, 3000)
      return
    }
    const r = await invoke('studio.canvas', { slug: board, assets })
    void loadCanvasList()
    if (!r.ok) {
      toast(`Couldn't add them to the board: ${r.error.message}`, undefined, 8000)
      return
    }
    const title =
      canvasStore.getState().entries?.find((e) => e.slug === board)?.title || 'the board'
    const target = board
    toast(`Added ${plural(r.value.added, 'image')} to ${title}`, {
      label: 'Open',
      run: () => openInApp(placeOf('canvas', { canvas: target }), 'here'),
    })
  }
  return (
    <EvaMenu opened={opened} onChange={open} position="top" width={250}>
      <EvaMenu.Target>{trigger}</EvaMenu.Target>
      <EvaMenu.Dropdown data-testid="studio-canvas-menu">
        <EvaMenu.Label>Add to board</EvaMenu.Label>
        {(entries ?? []).map((e) => (
          <EvaMenu.Item
            key={e.slug}
            leftSection={<IconLayoutBoard size={15} />}
            onClick={() => void add(e.slug)}
          >
            {e.title || e.slug}
          </EvaMenu.Item>
        ))}
        <EvaMenu.Divider />
        <EvaMenu.Item leftSection={<IconPlus size={15} />} onClick={() => void add(null)}>
          New board
        </EvaMenu.Item>
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}

/** "1 running · 2 waiting", "GPU idle": the host's active jobs, each with its estimate and a cancel. */
export function QueueIndicator() {
  const [opened, setOpened] = useState(false)
  const jobs = useStudio((s) => s.view.jobs)
  const up = useStudio((s) => s.view.up)
  const backends = useStudio((s) => s.view.backends)
  const active = jobs.filter(studioJobActive).sort((a, b) => a.createdAt - b.createdAt)
  const running = active.filter((j) => j.state === 'running')
  const waiting = active.filter((j) => j.state === 'queued')
  const label = !up
    ? 'Host offline'
    : active.length === 0
      ? 'GPU idle'
      : `${running.length} running${waiting.length ? ` · ${waiting.length} waiting` : ''}`
  return (
    <EvaPopover opened={opened} onChange={setOpened} position="bottom-end" width={340}>
      <EvaPopover.Target>
        <button
          type="button"
          className={`sl-quiet sl-queue-btn${active.length ? ' busy' : ''}`}
          aria-label="GPU queue"
          data-testid="studio-queue-button"
          onClick={() => setOpened((o) => !o)}
        >
          <IconCpu size={16} stroke={1.6} />
          <span>{label}</span>
        </button>
      </EvaPopover.Target>
      <EvaPopover.Dropdown className="sl-pop">
        <div className="sl-queue-list">
          <div className="sl-at-label">GPU queue</div>
          {active.length === 0 ? <div className="sl-queue-empty">Nothing running.</div> : null}
          {[...running, ...waiting].map((j) => (
            <div className="sl-queue-row" key={j.id} data-testid="studio-queue-row">
              <div className="sl-queue-main">
                <span>{engineLabel(j.spec, backends)}</span>
                <span className="sl-dim sl-small">
                  {j.state === 'running'
                    ? `Running ${Math.round(j.progress * 100)}%`
                    : (j.note ?? 'Waiting')}
                </span>
              </div>
              <span className="sl-queue-eta">{studioEtaLabel(j.etaMs) ?? ''}</span>
              <button
                type="button"
                className="sl-quiet sl-icon"
                aria-label="Cancel job"
                onClick={() => void cancelJob(j.id)}
              >
                <IconX size={14} />
              </button>
            </div>
          ))}
        </div>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}

/** The '@' list: saved Styles and Characters first, then images. */
export function AtPicker({
  images,
  onImage,
  onReference,
  onDone,
}: {
  images: { id: string; thumb: string }[]
  onImage?: (id: string) => void
  onReference: (ref: StudioReference) => void
  onDone: () => void
}) {
  const references = useStudio((s) => s.view.references)
  return (
    <div
      className="sl-at-pop"
      role="listbox"
      aria-label="References"
      data-testid="studio-at-picker"
    >
      {references.length > 0 ? (
        <>
          <div className="sl-at-label">Styles and characters</div>
          <div className="sl-at-list">
            {references.map((r) => (
              <button
                type="button"
                key={r.id}
                className="sl-at-ref"
                onClick={() => {
                  onReference(r)
                  onDone()
                }}
              >
                <img src={mediaSrc(r.asset.thumb)} alt="" />
                <span>{r.name}</span>
                {r.kind === 'style' ? <IconPalette size={14} /> : <IconUser size={14} />}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {onImage && images.length > 0 ? (
        <>
          <div className="sl-at-label">Images</div>
          <div className="sl-at-row">
            {images.map((v) => (
              <button
                type="button"
                key={v.id}
                aria-label="Use image"
                onClick={() => {
                  onImage(v.id)
                  onDone()
                }}
              >
                <img src={mediaSrc(v.thumb)} alt="" />
              </button>
            ))}
          </div>
        </>
      ) : null}
      {references.length === 0 && !(onImage && images.length > 0) ? (
        <div className="sl-at-label">Nothing to reference yet</div>
      ) : null}
    </div>
  )
}

/** Chips for what @ picked: a saved reference by name and kind, or a library image. */
export function RefChips({ ids, onRemove }: { ids: string[]; onRemove: (id: string) => void }) {
  const { references, lineage } = useLibrary()
  if (ids.length === 0) return null
  return (
    <div className="sl-ref-chips" data-testid="studio-ref-chips">
      {ids.map((id) => {
        const ref = references.find((r) => r.asset.id === id)
        const thumb = ref?.asset.thumb ?? lineage.byId.get(id)?.asset.thumb
        const name = ref?.name ?? 'Image'
        return (
          <span className="sl-ref-chip" key={id} data-testid="studio-ref-chip">
            {thumb ? <img src={mediaSrc(thumb)} alt="" /> : <IconPhoto size={14} />}
            {name}
            {ref ? (
              <span className="sl-kind">{ref.kind === 'style' ? 'Style' : 'Character'}</span>
            ) : null}
            <button type="button" aria-label={`Remove ${name}`} onClick={() => onRemove(id)}>
              <IconX size={12} />
            </button>
          </span>
        )
      })}
    </div>
  )
}
