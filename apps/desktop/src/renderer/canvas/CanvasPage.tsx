import { Button } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import { useEffect } from 'react'
import { placeOf, type Place } from '@evaos/shell-core'
import { replaceActivePlace } from '../tabs/tabs-store'
import { CanvasBoardView } from './CanvasBoard'
import { canvasStore, newBoard, useCanvasList, useCanvasListSurface } from './canvas-store'
import './canvas.css'

/** The Canvas page: the tab's board, else the newest; an empty folder offers a new board. */
export function CanvasPage({ place }: { place: Place }) {
  useCanvasListSurface()
  const entries = useCanvasList((s) => s.entries)
  const error = useCanvasList((s) => s.error)
  const slug = place.canvas
  const newest = entries?.[0]?.slug ?? null

  useEffect(() => {
    if (slug === null && newest !== null) replaceActivePlace(placeOf('canvas', { canvas: newest }))
  }, [slug, newest])

  useEffect(() => {
    if (slug !== null) canvasStore.setState({ shown: slug })
  }, [slug])

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
