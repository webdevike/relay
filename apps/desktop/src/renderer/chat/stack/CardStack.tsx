import './stack.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { useElementSize } from '@mantine/hooks'
import { IconChevronDown, IconChevronUp, IconX } from '@tabler/icons-react'
import { AnimatePresence, MotionGlobalConfig, motion, type Variants } from 'motion/react'
import { useActorRef, useSelector } from '@xstate/react'
import type { SnapshotFrom } from 'xstate'
import type { OpenAsk } from '@evaos/contract'
import { settleFront } from '@evaos/chat-core/card-stack'
import { DISMISS_PRIORITY, useDismissable } from '../../hotkeys/dismiss'
import { motionOff, onMotionGate } from '../../assistants/motion-gate'
import { cardStackMachine } from './card-stack.machine'
import { AskBody, DialogBody, RunningBody } from './CardBodies'
import type { RunCard, StackCard } from './stack-cards'

const SPRING = { type: 'spring', stiffness: 380, damping: 38 } as const
/** The closed tab's height. */
const TAB_H = 50
/** How far the card hangs down behind the composer. */
const TUCK = 18
/** Room the open card leaves under the chat's header. */
const HEAD_GAP = 12
const MIN_CAP = 240
/** Ids joined into one dependency (no card id holds a NUL). */
const SEP = '\u0000'

type Snap = SnapshotFrom<typeof cardStackMachine>
const selOpen = (s: Snap): boolean => s.matches('expanded')
const selIds = (s: Snap): readonly string[] => s.context.ids
const selFront = (s: Snap): string | null => s.context.front
const selDir = (s: Snap): -1 | 0 | 1 => s.context.dir
const selAnswered = (s: Snap): string | null => s.context.answered

/** How the front card moves: which way the stack stepped, and which card Isaac answered here. */
interface Move {
  dir: -1 | 0 | 1
  ids: readonly string[]
  answered: string | null
}

/**
 * Card `id` slides in the way the stack stepped and out the other way. When it leaves the stack it
 * lifts away if Isaac answered it here, and blurs out if the chat resolved it.
 */
const slide = (id: string): Variants => ({
  enter: (m: Move) => ({ opacity: 0, x: m.dir * 60 }),
  center: { opacity: 1, x: 0, y: 0, scale: 1, filter: 'blur(0px)' },
  exit: (m: Move) =>
    m.ids.includes(id)
      ? { opacity: 0, x: -m.dir * 60, transition: { duration: 0.2 } }
      : m.answered === id
        ? { opacity: 0, y: -28, scale: 0.97, transition: { duration: 0.28 } }
        : { opacity: 0, scale: 0.9, filter: 'blur(8px)', y: -10, transition: { duration: 0.35 } },
})

export interface CardStackProps {
  paneId: string
  /** The chat's cards in order (stack-cards.ts). */
  cards: readonly StackCard[]
  onAnswerAsk: (ask: OpenAsk, reply: string) => void
  onDismissAsk: (ask: OpenAsk) => void
  /** `split`: Cmd (or Ctrl) was held, so open it beside the pane instead of in place. */
  onOpenRun: (card: RunCard, split: boolean) => void
}

/**
 * The card stack on the composer: what needs Isaac, then what runs for the chat. Closed, an inset
 * tab names the front card, with a sliver above it while more wait; open, the tab grows up into the
 * card, its bottom tucked behind the composer, with dots to step between cards. A click outside or
 * Esc folds it back; a new question from the session opens it on that question. No cards, no tab.
 */
export function CardStack({ paneId, cards, onAnswerAsk, onDismissAsk, onOpenRun }: CardStackProps) {
  const ids = useMemo(() => cards.map((c) => c.id), [cards])
  const key = ids.join(SEP)
  const actor = useActorRef(cardStackMachine, { input: { loop: false, ids } })
  const expanded = useSelector(actor, selOpen)
  const known = useSelector(actor, selIds)
  const front = useSelector(actor, selFront)
  const dir = useSelector(actor, selDir)
  const answered = useSelector(actor, selAnswered)

  useEffect(() => {
    actor.send({ type: 'cards.changed', ids: key === '' ? [] : key.split(SEP) })
  }, [actor, key])

  // The session is blocked on a new question or approval: open the stack on it.
  const live = cards[0]?.kind === 'dialog' ? cards[0].id : null
  const seen = useRef<string | null>(null)
  useEffect(() => {
    if (live !== null && live !== seen.current) {
      actor.send({ type: 'stack.open', id: live })
      actor.send({ type: 'stack.show', id: live })
    }
    seen.current = live
  }, [actor, live])

  // Until the machine hears of a change, the front is where it is about to settle.
  const shownId = settleFront(known, ids, front)
  const shown = cards.find((c) => c.id === shownId) ?? cards[0]
  const open = expanded && shown !== undefined
  const move: Move = { dir: front !== null && ids.includes(front) ? dir : 0, ids, answered }

  const host = useRef<HTMLDivElement>(null)
  const { ref: sizeRef, height } = useElementSize()
  const [cap, setCap] = useState(520)
  useEffect(() => {
    if (!open) return
    // The open card may grow up to just under the chat's header (and an assistant's notch).
    const fit = (): void => {
      const h = host.current
      const chat = h?.closest('.eva-chat')
      const top =
        chat?.querySelector('.eva-chat-notch-room') ?? chat?.querySelector('.eva-chat-header')
      if (!h || !top) return
      const room = h.getBoundingClientRect().bottom + TUCK - top.getBoundingClientRect().bottom
      setCap(Math.max(MIN_CAP, room - HEAD_GAP))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [open])

  // A click anywhere outside the open card folds it back into the tab.
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent): void => {
      if (host.current && !host.current.contains(e.target as Node))
        actor.send({ type: 'stack.collapse' })
    }
    document.addEventListener('pointerdown', down)
    return () => document.removeEventListener('pointerdown', down)
  }, [open, actor])

  // Left and right arrows step between cards while open, outside text fields.
  useEffect(() => {
    if (!open) return
    const keydown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const target = e.target
      if (
        target instanceof Element &&
        target.closest('input, textarea, [contenteditable="true"], .xterm')
      )
        return
      if (e.key === 'ArrowRight') actor.send({ type: 'stack.step', by: 1 })
      else if (e.key === 'ArrowLeft') actor.send({ type: 'stack.step', by: -1 })
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [open, actor])

  // Esc folds it, after a focused composer (blur) or question card (Skip) had their turn.
  useDismissable(DISMISS_PRIORITY.cardStack, () => actor.send({ type: 'stack.collapse' }), open)

  // The app's motion setting, or the system's reduced motion, settles every move at once.
  useEffect(() => {
    const apply = (): void => {
      MotionGlobalConfig.skipAnimations = motionOff()
    }
    apply()
    return onMotionGate(apply)
  }, [])

  const markAnswered = (id: string): void => actor.send({ type: 'card.answered', id })

  const body = (card: StackCard) =>
    card.kind === 'dialog' ? (
      <DialogBody paneId={paneId} card={card} onAnswering={() => markAnswered(card.id)} />
    ) : card.kind === 'ask' ? (
      <AskBody
        card={card}
        onAnswer={(reply) => {
          markAnswered(card.id)
          onAnswerAsk(card.ask, reply)
        }}
      />
    ) : (
      <RunningBody card={card} onOpen={(split) => onOpenRun(card, split)} />
    )

  return (
    <AnimatePresence initial={false}>
      {shown !== undefined ? (
        <motion.div
          key="host"
          ref={host}
          className="eva-stack"
          data-testid="card-stack"
          data-state={open ? 'expanded' : 'collapsed'}
          data-front={shown.id}
          initial={{ height: 0 }}
          animate={{ height: TAB_H }}
          exit={{ height: 0, transition: { delay: 0.15 } }}
          transition={SPRING}
        >
          <AnimatePresence initial={false}>
            {cards.length > 1 ? (
              <motion.div
                key="peek"
                className="eva-stack-peek"
                data-testid="card-stack-peek"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: open ? 0 : 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
              />
            ) : null}
          </AnimatePresence>
          <motion.div
            className="eva-stack-card"
            initial={{ height: 0 }}
            animate={{
              height: open ? (height > 0 ? Math.min(cap, height) : 'auto') : TAB_H + TUCK,
            }}
            exit={{ height: 0 }}
            transition={SPRING}
          >
            <AnimatePresence initial={false}>
              {open ? (
                <motion.div
                  key="body"
                  className="eva-stack-body"
                  style={{ maxHeight: cap }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { delay: 0.08 } }}
                  exit={{ opacity: 0, transition: { duration: 0.1 } }}
                >
                  <div ref={sizeRef} style={{ paddingBottom: TUCK }}>
                    <div className="eva-stack-head">
                      <span className="eva-stack-title" data-testid="card-stack-title">
                        {shown.title}
                      </span>
                      <Tooltip label="Collapse" position="top">
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size="sm"
                          aria-label="Collapse"
                          data-testid="card-stack-collapse"
                          onClick={() => actor.send({ type: 'stack.collapse' })}
                        >
                          <IconChevronDown size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </div>
                    <div className="eva-stack-view">
                      <AnimatePresence mode="popLayout" initial={false} custom={move}>
                        <motion.div
                          key={shown.id}
                          className="eva-stack-slide"
                          data-testid="card-stack-card"
                          data-card-id={shown.id}
                          data-kind={shown.kind}
                          custom={move}
                          variants={slide(shown.id)}
                          initial="enter"
                          animate="center"
                          exit="exit"
                          transition={SPRING}
                        >
                          {body(shown)}
                        </motion.div>
                      </AnimatePresence>
                    </div>
                    {cards.length > 1 ? (
                      <div className="eva-stack-dots" role="group" aria-label="Cards">
                        {cards.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className="eva-stack-dot"
                            data-testid="card-stack-dot"
                            data-card-id={c.id}
                            data-on={c.id === shown.id ? 'true' : 'false'}
                            aria-current={c.id === shown.id ? 'true' : undefined}
                            aria-label={c.title}
                            onClick={() => actor.send({ type: 'stack.show', id: c.id })}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="face"
                  className="eva-stack-face"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.1 } }}
                >
                  <button
                    type="button"
                    className="eva-stack-row"
                    data-testid="card-stack-tab"
                    data-run={shown.kind === 'run' ? 'true' : undefined}
                    aria-expanded={false}
                    onClick={() => actor.send({ type: 'stack.open' })}
                  >
                    <span className="eva-stack-t1">{shown.title}</span>
                    {shown.kind === 'run' ? null : (
                      <IconChevronUp size={16} className="eva-stack-chev" aria-hidden />
                    )}
                  </button>
                  {shown.kind === 'run' ? (
                    <button
                      type="button"
                      className="eva-stack-open-link"
                      data-testid="card-stack-open-link"
                      onClick={(e) => onOpenRun(shown, e.metaKey || e.ctrlKey)}
                    >
                      Open session
                    </button>
                  ) : shown.kind === 'ask' ? (
                    <button
                      type="button"
                      className="eva-stack-dismiss"
                      data-testid="card-stack-dismiss"
                      aria-label="Dismiss this decision"
                      title="Dismiss this decision"
                      onClick={() => {
                        markAnswered(shown.id)
                        onDismissAsk(shown.ask)
                      }}
                    >
                      <IconX size={14} />
                    </button>
                  ) : null}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
