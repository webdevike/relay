import { placeOf, type Place } from '@evaos/shell-core'
import { useReplacePlace } from '../pages/place-host'
import { RoomSetupForm } from './RoomSetupForm'
import { openRoom } from './rooms-store'
import './rooms.css'

/** Assistants > Rooms > New room: Create room makes an idle room and this tab becomes it. */
export function NewRoomPage(_props: { place: Place }) {
  const replace = useReplacePlace()
  return (
    <div data-testid="rooms-new-page">
      <RoomSetupForm
        initial={null}
        submitLabel="Create room"
        onSubmit={async (setup) => {
          const r = await openRoom(setup)
          if ('error' in r) return r.error
          replace(placeOf(`room:${r.roomId}`))
          return null
        }}
      />
    </div>
  )
}
