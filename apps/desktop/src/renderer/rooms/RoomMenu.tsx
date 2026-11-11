import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ActionIcon, Button, Progress } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconCopy,
  IconDots,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import { roomRunAction } from '@evaos/contract'
import { openInApp } from '../navigation/open-in-app'
import { EvaMenu, EvaModal } from '../overlay'
import {
  deleteRoom,
  duplicateRoom,
  pauseRoom,
  renameRoom,
  resumeRoom,
  setEditing,
  setRenaming,
  useRooms,
} from './rooms-store'
import type { Room } from './types'

const failed = (message: string | null): void => {
  if (message !== null) notifications.show({ color: 'red', message, autoClose: 6000 })
}

/**
 * The room's menu (a nav row's right click, the room header's "..."): Rename, Pause or Resume when
 * the room can, Duplicate and Members for a chat room, Delete behind a confirm.
 */
export function RoomMenu({
  room,
  opened,
  onChange,
  target,
  position = 'bottom-end',
  renameIn,
}: {
  room: Room
  opened: boolean
  onChange: (opened: boolean) => void
  /** What the menu hangs from: its button, or an anchor at the pointer. */
  target: ReactElement
  position?: 'bottom-end' | 'bottom-start'
  /** Where Rename puts the title field: the nav row or the room's header. */
  renameIn: 'nav' | 'header'
}) {
  const [deleting, setDeleting] = useState(false)
  const run = roomRunAction(room)
  const chat = room.kind === 'chat'
  return (
    <>
      <EvaMenu opened={opened} onChange={onChange} width={200} position={position} offset={4}>
        <EvaMenu.Target>{target}</EvaMenu.Target>
        <EvaMenu.Dropdown data-testid="room-menu">
          <EvaMenu.Item
            data-testid="room-menu-rename"
            leftSection={<IconPencil size={16} stroke={1.5} />}
            onClick={() => setRenaming(room.id, renameIn)}
          >
            Rename
          </EvaMenu.Item>
          {run ? (
            <EvaMenu.Item
              data-testid={`room-menu-${run}`}
              leftSection={
                run === 'pause' ? (
                  <IconPlayerPause size={16} stroke={1.5} />
                ) : (
                  <IconPlayerPlay size={16} stroke={1.5} />
                )
              }
              onClick={() =>
                void (run === 'pause' ? pauseRoom(room.id) : resumeRoom(room.id)).then(failed)
              }
            >
              {run === 'pause' ? 'Pause' : 'Resume'}
            </EvaMenu.Item>
          ) : null}
          {chat ? (
            <>
              <EvaMenu.Item
                data-testid="room-menu-duplicate"
                leftSection={<IconCopy size={16} stroke={1.5} />}
                onClick={() =>
                  void duplicateRoom(room.id).then((id) => {
                    if (id === null) failed('Could not duplicate the room.')
                    else openInApp(placeOf(`room:${id}`))
                  })
                }
              >
                Duplicate
              </EvaMenu.Item>
              <EvaMenu.Item
                data-testid="room-menu-members"
                leftSection={<IconUsers size={16} stroke={1.5} />}
                onClick={() => {
                  setEditing(room.id)
                  openInApp(placeOf(`room:${room.id}`))
                }}
              >
                Members…
              </EvaMenu.Item>
            </>
          ) : null}
          <EvaMenu.Divider />
          <EvaMenu.Item
            data-testid="room-menu-delete"
            className="eva-cl-menu-danger"
            leftSection={<IconTrash size={16} stroke={1.5} />}
            onClick={() => setDeleting(true)}
          >
            Delete
          </EvaMenu.Item>
        </EvaMenu.Dropdown>
      </EvaMenu>
      <DeleteRoomModal room={deleting ? room : null} onClose={() => setDeleting(false)} />
    </>
  )
}

function DeleteRoomModal({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setError(null)
    setBusy(false)
  }, [room])
  const confirm = async (): Promise<void> => {
    if (!room || busy) return
    setBusy(true)
    const e = await deleteRoom(room.id)
    setBusy(false)
    if (e === null) onClose()
    else setError(e)
  }
  return (
    <EvaModal
      opened={room !== null}
      onClose={onClose}
      title="Delete room?"
      size={420}
      testid="room-delete-modal"
    >
      <p className="eva-cv-modal-body">
        {`"${room?.title ?? ''}" and its messages and files under work/rooms will be removed. This can't be undone.`}
      </p>
      {error ? (
        <p role="alert" className="eva-cv-modal-error">
          {error}
        </p>
      ) : null}
      <div className="eva-cv-modal-actions">
        <Button variant="default" data-autofocus onClick={onClose} data-testid="room-delete-cancel">
          Cancel
        </Button>
        <Button
          color="red"
          loading={busy}
          onClick={() => void confirm()}
          data-testid="room-delete-ok"
        >
          Delete
        </Button>
      </div>
    </EvaModal>
  )
}

/** The room's title as a field while it is renamed: Enter or leaving it saves, Escape cancels. */
export function RoomRenameField({ room, className }: { room: Room; className: string }) {
  const [value, setValue] = useState(room.title)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const end = (save: boolean): void => {
    if (done.current) return
    done.current = true
    setRenaming(null)
    const title = value.trim()
    if (save && title !== '' && title !== room.title) void renameRoom(room.id, title).then(failed)
  }
  return (
    <input
      ref={input}
      className={className}
      value={value}
      maxLength={120}
      aria-label="Room title"
      data-testid="room-rename-input"
      onChange={(e) => setValue(e.currentTarget.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') end(true)
        else if (e.key === 'Escape') end(false)
      }}
      onBlur={() => end(true)}
    />
  )
}

/** A room's title in its header; a field while it is renamed. */
export function RoomHeaderTitle({ id }: { id: string }) {
  const room = useRooms((s) => s.rooms[id] ?? null)
  const renaming = useRooms((s) => s.renaming?.id === id && s.renaming.where === 'header')
  if (!room) return null
  return renaming ? (
    <RoomRenameField room={room} className="eva-room-rename eva-room-rename-head" />
  ) : (
    <span className="eva-room-head-title" data-testid="room-title">
      {room.title}
    </span>
  )
}

/** The room header's right side: a chat room's spend against its budget, then "...": the room's menu. */
export function RoomHeaderMenu({ id }: { id: string }) {
  const room = useRooms((s) => s.rooms[id] ?? null)
  const [opened, setOpened] = useState(false)
  if (!room) return null
  const chat = room.chat
  return (
    <>
      {chat ? (
        <span className="eva-room-spend" data-testid="room-spend">
          <span>
            ${chat.spend.usd.toFixed(2)} / ${chat.setup.budget.toFixed(2)}
          </span>
          <Progress
            className="eva-room-spend-bar"
            size="xs"
            value={Math.min(100, (chat.spend.usd / chat.setup.budget) * 100)}
            aria-label="Spent of the budget"
          />
        </span>
      ) : null}
      <RoomMenu
        room={room}
        opened={opened}
        onChange={setOpened}
        renameIn="header"
        target={
          <ActionIcon
            variant="subtle"
            className="eva-header-btn"
            aria-label="Room options"
            title="Room options"
            data-testid="room-menu-button"
          >
            <IconDots size={16} stroke={1.5} />
          </ActionIcon>
        }
      />
    </>
  )
}
