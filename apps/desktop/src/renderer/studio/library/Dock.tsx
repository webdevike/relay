import { useEffect, useState } from 'react'
import { Button, TextInput } from '@mantine/core'
import {
  IconDownload,
  IconFolderShare,
  IconHeart,
  IconLayoutBoard,
  IconMessage,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import { EvaModal } from '../../overlay'
import { dismissToast, downloadAssets, toggleFavorites, trashAssets } from './actions'
import { Composer } from './Composer'
import { clearSelection, openModal, setSelected, useLocal } from './local'
import { AddToCanvas, MoveMenu, SendToChat } from './menus'

function BulkBar({ order }: { order: readonly string[] }) {
  const selected = useLocal((s) => s.selected)
  return (
    <div className="sl-bulk" role="toolbar" aria-label="Selection" data-testid="studio-bulk">
      <span className="sl-bulk-count" data-testid="studio-bulk-count">
        {selected.length} selected
      </span>
      <button type="button" className="sl-quiet" onClick={() => setSelected([...order])}>
        <span>Select all</span> <span className="sl-kbd-hint">{order.length}</span>
      </button>
      <span className="sl-grow" />
      <button type="button" className="sl-quiet" onClick={() => void toggleFavorites(selected)}>
        <IconHeart size={16} /> <span>Favorite</span>
      </button>
      <MoveMenu
        ids={selected}
        onDone={() => setSelected([])}
        trigger={
          <button type="button" className="sl-quiet">
            <IconFolderShare size={16} /> <span>Move to</span>
          </button>
        }
      />
      <SendToChat
        ids={selected}
        trigger={
          <button type="button" className="sl-quiet">
            <IconMessage size={16} /> <span>Send to chat</span>
          </button>
        }
      />
      <AddToCanvas
        ids={selected}
        trigger={
          <button type="button" className="sl-quiet">
            <IconLayoutBoard size={16} /> <span>Add to canvas</span>
          </button>
        }
      />
      <button type="button" className="sl-quiet" onClick={() => void downloadAssets(selected)}>
        <IconDownload size={16} /> <span>Download</span>
      </button>
      <button type="button" className="sl-quiet danger" onClick={() => trashAssets(selected)}>
        <IconTrash size={16} /> <span>Delete</span>
      </button>
      <button
        type="button"
        className="sl-quiet sl-icon"
        aria-label="Clear selection"
        onClick={clearSelection}
      >
        <IconX size={16} />
      </button>
    </div>
  )
}

export function Toasts() {
  const toasts = useLocal((s) => s.toasts)
  return (
    <>
      {toasts.map((t) => (
        <div className="sl-toast" key={t.id} role="status" data-testid="studio-toast">
          <span>{t.text}</span>
          {t.action ? (
            <button
              type="button"
              onClick={() => {
                t.action?.run()
                dismissToast(t.id)
              }}
            >
              {t.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </>
  )
}

/** Toasts with the bulk bar while images are selected, else the create bar. */
export function Dock({ order, notice }: { order: readonly string[]; notice: string | null }) {
  const selecting = useLocal((s) => s.selected.length > 0)
  return (
    <div className="sl-dock">
      <Toasts />
      {notice ? (
        <div className="sl-toast" role="alert" data-testid="studio-notice">
          <span>{notice}</span>
        </div>
      ) : null}
      {selecting ? <BulkBar order={order} /> : <Composer />}
    </div>
  )
}

/** The one name or confirm dialog (projects, references). */
export function ModalHost() {
  const modal = useLocal((s) => s.modal)
  const [text, setText] = useState('')
  useEffect(() => {
    if (modal?.kind === 'name') setText(modal.initial)
  }, [modal])
  const close = (): void => openModal(null)
  const submit = (): void => {
    if (modal?.kind !== 'name' || !text.trim()) return
    modal.onSubmit(text.trim())
    close()
  }
  return (
    <EvaModal
      opened={modal !== null}
      onClose={close}
      title={modal?.title}
      size={380}
      testid="studio-modal"
    >
      {modal?.kind === 'name' ? (
        <>
          <TextInput
            data-autofocus
            value={text}
            placeholder={modal.placeholder ?? 'Name'}
            aria-label={modal.placeholder ?? 'Name'}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
          <div className="sl-modal-actions">
            <Button variant="subtle" color="gray" onClick={close}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!text.trim()} data-testid="studio-modal-ok">
              {modal.cta}
            </Button>
          </div>
        </>
      ) : modal?.kind === 'confirm' ? (
        <>
          <p className="sl-modal-body">{modal.body}</p>
          <div className="sl-modal-actions">
            <Button variant="subtle" color="gray" onClick={close}>
              Cancel
            </Button>
            <Button
              color={modal.danger ? 'red' : undefined}
              data-testid="studio-modal-ok"
              onClick={() => {
                modal.onConfirm()
                close()
              }}
            >
              {modal.cta}
            </Button>
          </div>
        </>
      ) : null}
    </EvaModal>
  )
}
