import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { IDLE_SIGNALS, buildRig, type MotionState, type Portrait } from '@relay/portrait-motion'
import { PortraitPainter } from './portrait-painter'
import './portrait-motion.css'

/**
 * A portrait in full motion held in one face, `idle` or `talking` (the avatar editor's preview):
 * the same Extended-mode drawing as the start card, but the face is chosen by the caller instead
 * of an agent's signals. Rebuilt only when the portrait itself changes; the face switches live.
 */
export function AvatarPreview({
  portrait,
  size,
  face,
  testId,
}: {
  portrait: Portrait
  size: number
  face: Extract<MotionState, 'idle' | 'talking'>
  testId?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const held = useRef(face)
  held.current = face
  const [state, setState] = useState<MotionState>(face)
  const json = JSON.stringify(portrait)
  useEffect(() => {
    const painter = new PortraitPainter(host.current!, {
      rig: buildRig(JSON.parse(json) as Portrait),
      size,
      director: { next: () => held.current },
      signals: () => IDLE_SIGNALS,
      onState: setState,
    })
    return () => painter.destroy()
  }, [json, size])
  const { accent, paper } = portrait.colors ?? {}
  const style = {
    width: size,
    height: size,
    ...(accent === undefined ? {} : { '--eva-pm-accent': accent }),
    ...(paper === undefined ? {} : { '--eva-pm-paper': paper }),
  } as CSSProperties
  return (
    <div className="eva-pmc" data-state={state} style={style} data-testid={testId}>
      <div ref={host} className="eva-pmc-art" aria-hidden />
    </div>
  )
}
