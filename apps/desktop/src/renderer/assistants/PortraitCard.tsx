import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Director, STATE_META, buildRig, type MotionState } from '@relay/portrait-motion'
import type { AssistantPortrait } from '@evaos/contract'
import { chatStore } from '../chat/chat-store'
import { assistantsStore } from './assistants-store'
import { agentSignals } from './motion-store'
import { PortraitPainter } from './portrait-painter'
import './portrait-motion.css'

/**
 * Agent `id`'s portrait in full motion (the start card): every state the portrait-motion engine
 * draws, from the agent's real signals, greeting first (Hello) each time the page opens. Accent
 * overlays use the portrait's accent, else the app's primary color; the disc is its paper.
 */
export function PortraitCard({
  id,
  portrait,
  size,
  testId,
}: {
  id: string
  portrait: AssistantPortrait
  size: number
  testId?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<MotionState>('hello')
  // The list is replaced on every change; rebuild only when the face itself does.
  const face = JSON.stringify(portrait)
  useEffect(() => {
    const now = Date.now()
    const painter = new PortraitPainter(host.current!, {
      rig: buildRig(JSON.parse(face) as AssistantPortrait),
      size,
      director: new Director(now, { hello: true }),
      signals: () => agentSignals(id),
      onState: setState,
    })
    const poke = (): void => painter.poke()
    const offAssistants = assistantsStore.subscribe(poke)
    const offChat = chatStore.subscribe(poke)
    return () => {
      offAssistants()
      offChat()
      painter.destroy()
    }
  }, [id, face, size])
  const meta = STATE_META[state]
  const style = {
    width: size,
    height: size,
    ...(portrait.colors?.accent === undefined ? {} : { '--eva-pm-accent': portrait.colors.accent }),
    ...(portrait.colors?.paper === undefined ? {} : { '--eva-pm-paper': portrait.colors.paper }),
  } as CSSProperties
  return (
    <div
      className="eva-pmc"
      data-state={state}
      data-dot={meta.dot ?? undefined}
      style={style}
      data-testid={testId}
    >
      <div ref={host} className="eva-pmc-art" aria-hidden />
      {meta.dot === null ? null : (
        <span className="eva-pmc-dot" role="img" aria-label={meta.status} />
      )}
    </div>
  )
}
