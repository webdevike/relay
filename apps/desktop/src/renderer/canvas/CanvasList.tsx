import { Button, TextInput } from '@mantine/core'
import { IconPencil, IconPin, IconPinnedOff, IconSchema, IconTrash } from '@tabler/icons-react'
import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasEntry } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { openPlace } from '../navigation/navigate'
import { EvaMenu, EvaModal } from '../overlay'
import { activePlace, useTabs } from '../tabs/tabs-store'
import {
  deleteBoard,
  renameBoard,
  setPinned,
  useCanvasList,
  useCanvasListSurface,
} from './canvas-store'
import './canvas.css'

/** Pinned, then Recent (newest first), filtered by title or slug (native sidebar_list). */
export function sections(
  entries: readonly CanvasEntry[],
  query: string,
): Array<{ label: 'Pinned' | 'Recent'; entries: CanvasEntry[] }> {
  const q = query.trim().toLowerCase()
  const shown = entries.filter(
    (e) => q === '' || e.title.toLowerCase().includes(q) || e.slug.includes(q),
  )
  const out: Array<{ label: 'Pinned' | 'Recent'; entries: CanvasEntry[] }> = []
  const pinned = shown.filter((e) => e.pinned)
  const recent = shown.filter((e) => !e.pinned)
  if (pinned.length > 0) out.push({ label: 'Pinned', entries: pinned })
  if (recent.length > 0) out.push({ label: 'Recent', entries: recent })
  return out
}

function Row({
  entry,
  active,
  onMenu,
}: {
  entry: CanvasEntry
  active: boolean
  onMenu: (entry: CanvasEntry, x: number, y: number) => void
}) {
  const open = (e: MouseEvent): void =>
    openPlace(placeOf('canvas', { canvas: entry.slug }), { newTab: e.metaKey })
  return (
    <button
      type="button"
      className="eva-sb-row eva-cv-row"
      data-testid={`canvas-row-${entry.slug}`}
      data-active={active ? 'true' : undefined}
      aria-current={active ? 'page' : undefined}
      onClick={open}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(entry, e.clientX, e.clientY)
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'F10' && e.shiftKey) {
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          onMenu(entry, r.left + 16, r.bottom)
        }
      }}
    >
      <IconSchema size={16} stroke={1.5} aria-hidden className="eva-cv-row-icon" />
      <span className="eva-sb-row-label">{entry.title}</span>
      {entry.pinned ? <IconPin size={12} stroke={1.5} aria-label="Pinned" /> : null}
      <span className="eva-sb-count" data-testid={`canvas-count-${entry.slug}`}>
        {entry.nodes}
      </span>
    </button>
  )
}

function RenameModal({ entry, onClose }: { entry: CanvasEntry | null; onClose: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setName(entry?.title ?? '')
    setError(null)
    setBusy(false)
  }, [entry])
  const confirm = async (): Promise<void> => {
    if (!entry || busy) return
    setBusy(true)
    const r = await renameBoard(entry.slug, name)
    setBusy(false)
    if (r.ok) onClose()
    else setError(r.message)
  }
  return (
    <EvaModal
      opened={entry !== null}
      onClose={onClose}
      title="Rename board"
      size={420}
      testid="canvas-rename-modal"
    >
      <form
        className="eva-cv-modal"
        onSubmit={(e) => {
          e.preventDefault()
          void confirm()
        }}
      >
        <TextInput
          aria-label="Board name"
          data-testid="canvas-rename-input"
          data-autofocus
          value={name}
          maxLength={500}
          error={error}
          onChange={(e) => setName(e.currentTarget.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="eva-cv-modal-actions">
          <Button variant="default" onClick={onClose} data-testid="canvas-rename-cancel">
            Cancel
          </Button>
          <Button type="submit" loading={busy} data-testid="canvas-rename-ok">
            Rename
          </Button>
        </div>
      </form>
    </EvaModal>
  )
}

function DeleteModal({ entry, onClose }: { entry: CanvasEntry | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setError(null)
    setBusy(false)
  }, [entry])
  const confirm = async (): Promise<void> => {
    if (!entry || busy) return
    setBusy(true)
    const r = await deleteBoard(entry.slug)
    setBusy(false)
    if (r.ok) onClose()
    else setError(r.message)
  }
  return (
    <EvaModal
      opened={entry !== null}
      onClose={onClose}
      title="Delete board?"
      size={420}
      testid="canvas-delete-modal"
    >
      <p className="eva-cv-modal-body">
        {`"${entry?.title ?? ''}" (${entry?.slug ?? ''}.json) will be removed. This can't be undone.`}
      </p>
      {error ? (
        <p role="alert" className="eva-cv-modal-error">
          {error}
        </p>
      ) : null}
      <div className="eva-cv-modal-actions">
        <Button
          variant="default"
          data-autofocus
          onClick={onClose}
          data-testid="canvas-delete-cancel"
        >
          Cancel
        </Button>
        <Button
          color="red"
          loading={busy}
          onClick={() => void confirm()}
          data-testid="canvas-delete-ok"
        >
          Delete
        </Button>
      </div>
    </EvaModal>
  )
}

/** Sidebar body for the Canvas sub-page: Pinned and Recent boards, each with a menu. */
export function CanvasList({ query }: { query: string }) {
  useCanvasListSurface()
  const entries = useCanvasList((s) => s.entries)
  const error = useCanvasList((s) => s.error)
  const here = useTabs(activePlace)
  const [menu, setMenu] = useState<{ entry: CanvasEntry; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<CanvasEntry | null>(null)
  const [deleting, setDeleting] = useState<CanvasEntry | null>(null)
  const groups = useMemo(() => (entries ? sections(entries, query) : []), [entries, query])

  if (entries === null) {
    return (
      <div
        className="eva-sb-empty eva-dim"
        role={error ? 'alert' : undefined}
        data-testid="sidebar-sub-empty"
      >
        {error ? 'Could not read the canvases folder.' : 'Loading boards'}
      </div>
    )
  }
  const active = here.page === 'canvas' ? here.canvas : null
  return (
    <div className="eva-cv-list" data-testid="canvas-list">
      {groups.length === 0 ? (
        <div className="eva-sb-empty eva-dim" data-testid="sidebar-sub-empty">
          {query.trim() === '' ? 'No boards yet' : 'No boards match'}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.label} aria-label={g.label}>
            <h3 className="eva-cv-list-label" data-testid="canvas-section">
              {g.label}
            </h3>
            {g.entries.map((e) => (
              <Row
                key={e.slug}
                entry={e}
                active={active === e.slug}
                onMenu={(entry, x, y) => setMenu({ entry, x, y })}
              />
            ))}
          </section>
        ))
      )}
      {createPortal(
        <EvaMenu
          opened={menu !== null}
          onChange={(o) => {
            if (!o) setMenu(null)
          }}
          width={220}
          position="bottom-start"
          offset={0}
        >
          <EvaMenu.Target>
            <span
              className="eva-cl-menu-anchor"
              style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
              aria-hidden
            />
          </EvaMenu.Target>
          <EvaMenu.Dropdown data-testid="canvas-menu">
            {menu ? (
              <>
                <EvaMenu.Item
                  data-testid="canvas-menu-rename"
                  leftSection={<IconPencil size={16} stroke={1.5} />}
                  onClick={() => setRenaming(menu.entry)}
                >
                  Rename board
                </EvaMenu.Item>
                <EvaMenu.Item
                  data-testid="canvas-menu-pin"
                  leftSection={
                    menu.entry.pinned ? (
                      <IconPinnedOff size={16} stroke={1.5} />
                    ) : (
                      <IconPin size={16} stroke={1.5} />
                    )
                  }
                  onClick={() => void setPinned(menu.entry.slug, !menu.entry.pinned)}
                >
                  {menu.entry.pinned ? 'Unpin board' : 'Pin board'}
                </EvaMenu.Item>
                <EvaMenu.Divider />
                <EvaMenu.Item
                  data-testid="canvas-menu-delete"
                  className="eva-cl-menu-danger"
                  leftSection={<IconTrash size={16} stroke={1.5} />}
                  onClick={() => setDeleting(menu.entry)}
                >
                  Delete
                </EvaMenu.Item>
              </>
            ) : null}
          </EvaMenu.Dropdown>
        </EvaMenu>,
        document.body,
      )}
      <RenameModal entry={renaming} onClose={() => setRenaming(null)} />
      <DeleteModal entry={deleting} onClose={() => setDeleting(null)} />
    </div>
  )
}
