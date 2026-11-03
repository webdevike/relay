import { Button } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { placeOf, type Place } from '@evaos/shell-core'
import { useReplacePlace } from '../pages/place-host'
import { CanvasBoardView } from './CanvasBoard'
import { canvasStore, newBoard, useCanvasList, useCanvasListSurface } from './canvas-store'
import { LiveCanvasView } from './live/LiveCanvasView'
import { liveRoomOn, useLiveRooms } from './live/live-store'
import './canvas.css'

/**
 * The Canvas page: the tab's board, else the newest; an empty folder offers a new board. A board a
 * live room holds shows the room instead, and keeps showing it (ended) until Isaac moves on.
 */
export function CanvasPage({ place }: { place: Place }) {
  useCanvasListSurface()
  const entries = useCanvasList((s) => s.entries)
  const error = useCanvasList((s) => s.error)
  const slug = place.canvas
  const replacePlace = useReplacePlace()
  const newest = entries?.[0]?.slug ?? null
  const liveId = useLiveRooms((s) =>
    slug === null ? null : (liveRoomOn(s.data, slug)?.id ?? null),
  )
  // The room shown here: it stays after it ends, so the page can say so.
  const [roomId, setRoomId] = useState<string | null>(liveId)
  useEffect(() => {
    if (liveId !== null) setRoomId(liveId)
  }, [liveId])

  useEffect(() => {
    if (slug === null && newest !== null) replacePlace(placeOf('canvas', { canvas: newest }))
  }, [slug, newest, replacePlace])

  useEffect(() => {
    if (slug !== null) canvasStore.setState({ shown: slug })
  }, [slug])

  const shownRoom = liveId ?? roomId
  if (slug !== null && shownRoom !== null) {
    return <LiveCanvasView slug={slug} roomId={shownRoom} onBoard={() => setRoomId(null)} />
  }
  if (slug !== null) return <CanvasBoardView slug={slug} />
  if (entries === null) {
    return (
      <div className="eva-cv-empty" data-testid="canvas-empty">
        {error ? 'Could not read the canvases folder.' : 'Loading boards'}
      </div>
    )
  }
  return (
    <div className="eva-cv-empty" data-testid="canvas-empty">
      <span>No board open. Pick one in the sidebar, or start one.</span>
      <Button
        size="compact-sm"
        variant="default"
        leftSection={<IconPlus size={14} stroke={1.5} />}
        data-testid="canvas-empty-new"
        onClick={() => void newBoard()}
      >
        New board
      </Button>
    </div>
  )
}
