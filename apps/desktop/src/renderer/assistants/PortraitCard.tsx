import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Director, buildRig } from '@relay/portrait-motion'
import type { AssistantPortrait } from '@evaos/contract'
import { chatStore } from '../chat/chat-store'
import { assistantsStore } from './assistants-store'
import { IDLE_VIEW, agentSignals, dotLabel, type PortraitView } from './motion-store'
import { PortraitPainter } from './portrait-painter'
import './portrait-motion.css'

/**
 * Agent `id`'s portrait in full motion (the start card): the face the portrait-motion engine
 * draws for the agent's real signals (Idle, Thinking, Researching with its magnifier, Working)
 * and the status dot. Accent overlays use the portrait's accent, else the app's primary color;
 * the disc is its paper.
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
  const [view, setView] = useState<PortraitView>(IDLE_VIEW)
  // The list is replaced on every change; rebuild only when the face itself does.
  const face = JSON.stringify(portrait)
  useEffect(() => {
    const painter = new PortraitPainter(host.current!, {
      rig: buildRig(JSON.parse(face) as AssistantPortrait),
      size,
      director: new Director(),
      signals: () => agentSignals(id),
      onView: setView,
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
  const style = {
    width: size,
    height: size,
    ...(portrait.colors?.accent === undefined ? {} : { '--eva-pm-accent': portrait.colors.accent }),
    ...(portrait.colors?.paper === undefined ? {} : { '--eva-pm-paper': portrait.colors.paper }),
  } as CSSProperties
  return (
    <div
      className="eva-pmc"
      data-state={view.state}
      data-dot={view.dot ?? undefined}
      style={style}
      data-testid={testId}
    >
      <div ref={host} className="eva-pmc-art" aria-hidden />
      {view.dot === null ? null : (
        <span className="eva-pmc-dot" role="img" aria-label={dotLabel(view)} />
      )}
    </div>
  )
}
