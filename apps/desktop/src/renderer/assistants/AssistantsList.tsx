import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ActionIcon, Avatar } from '@mantine/core'
import { IconPlus, IconUsersGroup } from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import { roomIsLive, type Assistant } from '@evaos/contract'
import { WorkspaceDot } from '../agent/WorkspaceDot'
import { openFromNav } from '../navigation/open-in-app'
import { RoomMenu, RoomRenameField } from '../rooms/RoomMenu'
import { roomIdOf, useRooms } from '../rooms/rooms-store'
import type { Room } from '../rooms/types'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { portrait } from '../ui/portrait'
import { ListRow, ListView, rowTip } from '../ui/list'
import { agentIdOf, useAssistants } from './assistants-store'
import { PortraitMotion } from './PortraitMotion'
import './assistants.css'
import '../rooms/rooms.css'

type Row = { kind: 'agent'; a: Assistant } | { kind: 'room'; r: Room } | { kind: 'new' }

/** What a room row says on its right: Idle before anything ran, Paused, a green dot while live. */
function RoomTag({ room }: { room: Room }) {
  if (room.phase === 'idle')
    return room.messages.length === 0 ? <small className="eva-room-tag">Idle</small> : null
  if (room.phase === 'paused') return <small className="eva-room-tag">Paused</small>
  if (roomIsLive(room.phase)) return <span className="eva-room-live" aria-label="Live" />
  return null
}

/**
 * The sidebar's Assistants page (native assistants_view::sidebar_list): one row per agent, its
 * portrait beside its title and scope, breathing with the agent's mood (PortraitMotion); then
 * Rooms: one row per room (right click for its menu) and New room. The open one is highlighted.
 */
export function AssistantsList() {
  const agents = useAssistants((s) => s.data?.agents ?? null)
  const here = useTabs(activePlace)
  const order = useRooms((s) => s.order)
  const rooms = useRooms((s) => s.rooms)
  const renaming = useRooms((s) => (s.renaming?.where === 'nav' ? s.renaming.id : null))
  // The menu stays mounted after it closes, so the Delete confirm it opened stays up.
  const [menu, setMenu] = useState<{ room: Room; x: number; y: number; open: boolean } | null>(null)
  if (agents === null) return null
  const open = agentIdOf(here)
  const openRoom = roomIdOf(here.page)
  const roomRows: Row[] = [
    ...order.flatMap((id): Row[] => (rooms[id] ? [{ kind: 'room', r: rooms[id] }] : [])),
    { kind: 'new' },
  ]
  return (
    <>
      <ListView<Row>
        data-testid="assistants-list"
        density="compact"
        groups={[
          { id: 'agents', items: agents.map((a): Row => ({ kind: 'agent', a })) },
          {
            id: 'rooms',
            label: 'Rooms',
            count: null,
            collapsible: false,
            testid: 'assistants-rooms',
            actions: (
              <ActionIcon
                variant="subtle"
                size="var(--eva-kit-control-sm)"
                aria-label="New room"
                title="New room"
                data-testid="rooms-new-button"
                onClick={(e) => openFromNav(placeOf('rooms'), e)}
              >
                <IconPlus size="calc(var(--eva-font-size) * .875)" stroke={1.5} />
              </ActionIcon>
            ),
            items: roomRows,
          },
        ]}
        rowKey={(row) =>
          row.kind === 'agent' ? row.a.id : row.kind === 'room' ? `room:${row.r.id}` : 'room-new'
        }
        renderRow={(row) => {
          if (row.kind === 'agent') {
            const a = row.a
            return (
              <ListRow
                key={a.id}
                data-testid={`sidebar-agent-${a.id}`}
                active={open === a.id}
                aria-current={open === a.id ? 'page' : undefined}
                leading={
                  <PortraitMotion id={a.id} testId={`sidebar-portrait-${a.id}`}>
                    <Avatar
                      className="eva-as-avatar"
                      size="sm"
                      radius="xl"
                      src={portrait(a.avatar)}
                      alt=""
                      aria-hidden
                    />
                  </PortraitMotion>
                }
                title={a.title}
                trailing={<WorkspaceDot ws={`page:agent:${a.id}`} testId={`sidebar-dot-${a.id}`} />}
                tooltip={rowTip(a.title, a.scope)}
                onActivate={(e) => openFromNav(placeOf(`agent:${a.id}`), e)}
                middleClick
              />
            )
          }
          if (row.kind === 'new') {
            return (
              <ListRow
                key="room-new"
                data-testid="sidebar-room-new"
                dim
                active={here.page === 'rooms'}
                leading={
                  <span className="eva-room-glyph" aria-hidden>
                    <IconPlus size={12} stroke={1.5} />
                  </span>
                }
                title="New room"
                onActivate={(e) => openFromNav(placeOf('rooms'), e)}
              />
            )
          }
          const r = row.r
          return (
            <ListRow
              key={r.id}
              data-testid={`sidebar-room-${r.id}`}
              active={openRoom === r.id}
              aria-current={openRoom === r.id ? 'page' : undefined}
              leading={
                <span className="eva-room-glyph" aria-hidden>
                  <IconUsersGroup size={12} stroke={1.5} />
                </span>
              }
              title={
                renaming === r.id ? (
                  <RoomRenameField room={r} className="eva-room-rename" />
                ) : (
                  r.title
                )
              }
              trailing={<RoomTag room={r} />}
              tooltip={renaming === r.id ? undefined : r.title}
              onActivate={(e) => {
                if (renaming !== r.id) openFromNav(placeOf(`room:${r.id}`), e)
              }}
              middleClick
              onMenu={(x, y) => setMenu({ room: r, x, y, open: true })}
            />
          )
        }}
      />
      {menu
        ? createPortal(
            <RoomMenu
              room={rooms[menu.room.id] ?? menu.room}
              opened={menu.open}
              position="bottom-start"
              renameIn="nav"
              onChange={(o) => setMenu({ ...menu, open: o })}
              target={
                <span
                  className="eva-cl-menu-anchor"
                  style={{ left: menu.x, top: menu.y }}
                  aria-hidden
                />
              }
            />,
            document.body,
          )
        : null}
    </>
  )
}
