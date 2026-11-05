/**
 * The board's pages: a quiet button with the current page's title that opens the page list. Click
 * switches, double-click renames in place (Enter saves, Escape cancels), rows drag to reorder and
 * each has a menu (Rename, Duplicate, Delete). The last row adds a page.
 */
import { ActionIcon, Button, Menu, Modal, Popover, TextInput } from '@mantine/core'
import {
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconDots,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react'
import { useRef, useState, type KeyboardEvent } from 'react'
import type { CanvasPage } from '@evaos/contract'

/** How long a click waits for a second one (a rename) before it switches pages. */
const SWITCH_DELAY = 220

export interface PagePanelProps {
  pages: readonly CanvasPage[]
  page: string
  /** False while something else (a live room) holds the board: pages can be read but not changed. */
  editable: boolean
  onSwitch: (id: string) => void
  onAdd: () => void
  onRename: (id: string, title: string) => void
  onMove: (id: string, to: number) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}

export function PagePanel(props: PagePanelProps) {
  const { pages, page, editable } = props
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [dragged, setDragged] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const pick = useRef<number | undefined>(undefined)

  const current = pages.find((p) => p.id === page)
  const doomed = pages.find((p) => p.id === confirm)

  const startRename = (p: CanvasPage): void => {
    if (!editable) return
    setDraft(p.title)
    setRenaming(p.id)
  }
  const finishRename = (save: boolean): void => {
    const id = renaming
    setRenaming(null)
    if (save && id !== null) {
      const title = draft.trim()
      const was = pages.find((p) => p.id === id)?.title
      if (title !== '' && title !== was) props.onRename(id, title)
    }
  }
  const keys = (e: KeyboardEvent): void => {
    // The board's own keys (Delete removes the selection) stay out of the panel.
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      finishRename(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      finishRename(false)
    }
  }

  return (
    <div className="eva-cv-pages" data-cv-pages onKeyDown={(e) => e.stopPropagation()}>
      <Popover
        opened={open}
        onChange={setOpen}
        position="bottom-start"
        offset={4}
        withinPortal
        shadow="md"
        transitionProps={{ duration: 0 }}
        trapFocus={false}
        returnFocus={false}
        closeOnEscape={renaming === null}
      >
        <Popover.Target>
          <Button
            variant="subtle"
            color="gray"
            size="compact-sm"
            className="eva-cv-pages-button"
            data-testid="canvas-pages-button"
            aria-haspopup="listbox"
            aria-expanded={open}
            rightSection={<IconChevronDown size={14} stroke={1.5} />}
            onClick={() => setOpen((o) => !o)}
          >
            <span className="eva-cv-pages-current">{current?.title ?? 'Page 1'}</span>
          </Button>
        </Popover.Target>
        <Popover.Dropdown className="eva-cv-pages-pop" data-cv-pages data-testid="canvas-pages">
          <div role="listbox" aria-label="Pages" onKeyDown={(e) => e.stopPropagation()}>
            {pages.map((p, i) => {
              const here = p.id === page
              return (
                <div
                  key={p.id}
                  role="option"
                  aria-selected={here}
                  className="eva-cv-page-row"
                  data-testid="canvas-page-row"
                  data-page={p.id}
                  data-current={here ? 'true' : undefined}
                  data-over={over === p.id && dragged !== p.id ? 'true' : undefined}
                  draggable={editable && renaming === null}
                  onDragStart={(e) => {
                    setDragged(p.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => {
                    if (dragged === null) return
                    e.preventDefault()
                    setOver(p.id)
                  }}
                  onDragEnd={() => {
                    setDragged(null)
                    setOver(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    // The row dropped on takes the dragged row's place.
                    if (dragged !== null && dragged !== p.id) props.onMove(dragged, i)
                    setDragged(null)
                    setOver(null)
                  }}
                  onClick={() => {
                    if (renaming === p.id) return
                    // A second click within the delay is a rename, not a switch.
                    window.clearTimeout(pick.current)
                    pick.current = window.setTimeout(() => {
                      setOpen(false)
                      if (!here) props.onSwitch(p.id)
                    }, SWITCH_DELAY)
                  }}
                  onDoubleClick={() => {
                    window.clearTimeout(pick.current)
                    startRename(p)
                  }}
                >
                  <span className="eva-cv-page-mark" aria-hidden>
                    {here ? <IconCheck size={14} stroke={1.75} /> : null}
                  </span>
                  {renaming === p.id ? (
                    <TextInput
                      size="xs"
                      autoFocus
                      className="eva-cv-page-input"
                      data-testid="canvas-page-input"
                      aria-label="Page name"
                      value={draft}
                      maxLength={200}
                      onChange={(e) => setDraft(e.currentTarget.value)}
                      onKeyDown={keys}
                      onBlur={() => finishRename(true)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="eva-cv-page-title" data-here={here ? 'true' : undefined}>
                      {p.title}
                    </span>
                  )}
                  <Menu position="bottom-end" withinPortal={false} offset={2} shadow="md">
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        className="eva-cv-page-menu"
                        data-testid="canvas-page-menu"
                        aria-label={`Page ${p.title} menu`}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <IconDots size={14} stroke={1.5} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown data-cv-pages onClick={(e) => e.stopPropagation()}>
                      <Menu.Item
                        leftSection={<IconPencil size={14} stroke={1.5} />}
                        disabled={!editable}
                        data-testid="canvas-page-rename"
                        onClick={() => startRename(p)}
                      >
                        Rename
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconCopy size={14} stroke={1.5} />}
                        disabled={!editable}
                        data-testid="canvas-page-duplicate"
                        onClick={() => {
                          setOpen(false)
                          props.onDuplicate(p.id)
                        }}
                      >
                        Duplicate
                      </Menu.Item>
                      <Menu.Item
                        color="red"
                        leftSection={<IconTrash size={14} stroke={1.5} />}
                        disabled={!editable || pages.length <= 1}
                        data-testid="canvas-page-delete"
                        data-index={i}
                        onClick={() => {
                          setOpen(false)
                          setConfirm(p.id)
                        }}
                      >
                        Delete
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </div>
              )
            })}
          </div>
          <button
            type="button"
            className="eva-cv-page-add"
            data-testid="canvas-page-add"
            disabled={!editable}
            onClick={() => {
              setOpen(false)
              props.onAdd()
            }}
          >
            <span className="eva-cv-page-mark" aria-hidden>
              <IconPlus size={14} stroke={1.5} />
            </span>
            <span className="eva-cv-page-title">Add page</span>
          </button>
        </Popover.Dropdown>
      </Popover>
      <Modal
        opened={doomed !== undefined}
        onClose={() => setConfirm(null)}
        title="Delete page"
        size="sm"
        centered
        data-cv-pages
      >
        <p className="eva-cv-page-confirm" data-testid="canvas-page-confirm">
          {`Delete "${doomed?.title ?? ''}" and everything on it?`}
        </p>
        <div className="eva-cv-page-confirm-actions">
          <Button variant="default" size="xs" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            color="red"
            size="xs"
            data-testid="canvas-page-confirm-delete"
            onClick={() => {
              const id = confirm
              setConfirm(null)
              if (id !== null) props.onDelete(id)
            }}
          >
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  )
}
