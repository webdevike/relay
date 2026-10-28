import './reactions.css'
import { useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconMoodSmile } from '@tabler/icons-react'
import type { ChatMessage } from '@evaos/chat-core/message'
import { reactionExcerpt, reactionKeyOf, toggleReaction } from '@evaos/chat-core/reactions'
import { EvaPopover } from '../../overlay'
import { BubbleMenu } from './BubbleMenu'
import { ReactionBadge } from './ReactionBadge'
import { ReactionBar } from './ReactionBar'
import { ReactionScope, react, useReactions, type ReactionScopeValue } from './reactions-store'

export const RELAY_DOWN = "Reactions need Relay, and it isn't connected."

/** `text` as a markdown quote for the composer: each line behind `> `, then a blank line. */
export function quoteOf(text: string): string {
  return `${text
    .trim()
    .split('\n')
    .map((l) => (l === '' ? '>' : `> ${l}`))
    .join('\n')}\n\n`
}

/**
 * Tapbacks and the context menu for one user or assistant bubble. Hovering shows a react button on
 * the bubble's top `corner`; it (or the reaction badge there) opens the bar above the bubble.
 * Right-click opens the bar and a menu at the pointer. Escape or a click elsewhere closes both.
 * Outside a ReactionScope the bubble renders as is.
 */
export function BubbleActions(props: {
  m: ChatMessage
  corner: 'start' | 'end'
  children: ReactNode
}) {
  const scope = useContext(ReactionScope)
  if (scope === null) return <>{props.children}</>
  return <Actions {...props} scope={scope} />
}

/** Open: the bar alone (from the button), or the bar with the menu at `at` (right-click). */
type Open = { menu: { x: number; y: number } | null }

function Actions({
  m,
  corner,
  children,
  scope,
}: {
  m: ChatMessage
  corner: 'start' | 'end'
  children: ReactNode
  scope: ReactionScopeValue
}) {
  const key = reactionKeyOf(m)
  const thread = scope.thread
  const reactable = thread !== null && key !== null
  const up = useReactions((s) => s.up)
  const current = useReactions((s) =>
    thread !== null && key !== null ? (s.threads[thread]?.[key]?.emoji ?? null) : null,
  )
  const [open, setOpen] = useState<Open | null>(null)
  const content = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const cornerRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const canBar = reactable && up
  const barOpen = open !== null && canBar

  const close = (): void => {
    // Focus inside the bar goes back to the button that opened it.
    const restore = barRef.current?.contains(document.activeElement) ?? false
    setOpen(null)
    if (restore) trigger.current?.focus()
  }

  // Both overlays ignore Mantine's own outside click (each would count the other as outside).
  useEffect(() => {
    if (open === null) return
    const down = (e: PointerEvent): void => {
      const t = e.target
      if (!(t instanceof Node)) return
      for (const el of [cornerRef.current, barRef.current, menuRef.current])
        if (el?.contains(t)) return
      setOpen(null)
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [open])

  const pick = (emoji: string): void => {
    if (thread === null || key === null) return
    void react(thread, key, toggleReaction(current, emoji), reactionExcerpt(m.text))
    close()
  }

  const onContextMenu = (e: MouseEvent<HTMLDivElement>): void => {
    e.preventDefault()
    // The context-menu key has no pointer: the menu opens under the bubble.
    const r = e.currentTarget.getBoundingClientRect()
    const keyboard = e.clientX === 0 && e.clientY === 0
    setOpen({ menu: keyboard ? { x: r.left, y: r.bottom } : { x: e.clientX, y: e.clientY } })
  }

  const copy = (text: string): void => void navigator.clipboard.writeText(text).catch(() => {})
  const toggleBar = (): void => (open === null ? setOpen({ menu: null }) : close())

  return (
    <EvaPopover
      opened={barOpen}
      onChange={(o) => {
        if (!o) close()
      }}
      position={corner === 'start' ? 'top-start' : 'top-end'}
      offset={8}
      withRoles={false}
      closeOnClickOutside={false}
      // From the button the bar takes focus; with the menu open, the menu does.
      trapFocus={open?.menu === null}
      returnFocus={false}
    >
      <EvaPopover.Target>
        <div
          className="eva-bubble-wrap"
          data-corner={corner}
          data-open={open !== null ? 'true' : undefined}
          data-testid={`bubble-${m.id}`}
          onContextMenu={onContextMenu}
        >
          <div ref={content} className="eva-bubble-content">
            {children}
          </div>
          <div ref={cornerRef} className="eva-react-corner" data-corner={corner}>
            {current !== null ? (
              <ReactionBadge
                ref={trigger}
                emoji={current}
                testId={`reaction-badge-${m.id}`}
                expanded={barOpen}
                onOpen={canBar ? toggleBar : undefined}
              />
            ) : reactable ? (
              <Tooltip label={up ? 'React' : RELAY_DOWN} openDelay={300} disabled={barOpen}>
                <ActionIcon
                  ref={trigger}
                  variant="default"
                  radius="xl"
                  size="sm"
                  className="eva-react-btn"
                  data-testid={`react-btn-${m.id}`}
                  aria-label={up ? 'React' : RELAY_DOWN}
                  aria-haspopup="dialog"
                  aria-expanded={barOpen}
                  // Not `disabled`: the tooltip still says why.
                  data-disabled={up ? undefined : true}
                  aria-disabled={!up}
                  onClick={() => {
                    if (up) toggleBar()
                  }}
                >
                  <IconMoodSmile size={15} stroke={1.5} />
                </ActionIcon>
              </Tooltip>
            ) : null}
          </div>
          <BubbleMenu
            at={open?.menu ?? null}
            onClose={close}
            dropdownRef={menuRef}
            actions={{
              reply: () => scope.reply(quoteOf(m.text)),
              // The reply as it reads (innerText keeps its line breaks), else its markdown.
              copy: () => {
                const shown = content.current?.innerText ?? content.current?.textContent
                copy(m.role === 'assistant' && shown ? shown : m.text)
              },
              copyMarkdown: m.role === 'assistant' ? () => copy(m.text) : undefined,
              selectText: () => {
                if (content.current) window.getSelection()?.selectAllChildren(content.current)
              },
            }}
          />
        </div>
      </EvaPopover.Target>
      <EvaPopover.Dropdown
        ref={barRef}
        className="eva-reaction-pop"
        role="dialog"
        aria-label="Reactions"
      >
        <ReactionBar current={current} onPick={pick} />
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
