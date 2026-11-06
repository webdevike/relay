import './asks.css'
import { useState } from 'react'
import { ActionIcon, Button } from '@mantine/core'
import { EvaPopover } from '../../overlay'
import { IconChevronLeft, IconChevronRight, IconMessageQuestion } from '@tabler/icons-react'
import { jumpToAsk } from './ask-jump'
import { resolveAsk, useOpenAsks } from './asks-store'

/**
 * The questions the host still waits on Isaac for, as one quiet line above the composer: how many,
 * and the oldest one's short label. A click scrolls to the bubble that asked it (it flashes, then
 * keeps an accent edge and a tag until answered); arrows step through the others. An ask with no
 * bubble in the log (another session's question) opens a small card with its answers instead.
 * Answering anywhere, or the host resolving it, takes it off the line.
 */
export function AskBadges({ paneId, agent }: { paneId: string; agent: string | null }) {
  const asks = useOpenAsks(agent)
  const [at, setAt] = useState(0)
  const [card, setCard] = useState(false)
  if (agent === null || asks.length === 0) return null
  const i = at % asks.length
  const ask = asks[i]!
  const step = (dir: 1 | -1): void => {
    setCard(false)
    setAt((asks.length + i + dir) % asks.length)
  }
  return (
    <div className="eva-ask-badges" role="group" aria-label="Open asks" data-testid="ask-badges">
      <EvaPopover opened={card} onChange={setCard} position="top-start" shadow="none">
        <EvaPopover.Target>
          <button
            type="button"
            className="eva-ask-badge"
            data-testid="ask-badge"
            aria-label={`${String(asks.length)} waiting on you: ${ask.label}`}
            onClick={() => {
              if (!jumpToAsk(paneId, ask)) setCard((v) => !v)
            }}
          >
            <IconMessageQuestion
              size={14}
              stroke={1.5}
              className="eva-ask-badge-icon"
              aria-hidden="true"
            />
            <span className="eva-ask-badge-count">
              {asks.length === 1 ? '1 waiting' : `${String(asks.length)} waiting`}
            </span>
            <span className="eva-ask-badge-label" data-testid="ask-badge-label">
              {ask.label}
            </span>
          </button>
        </EvaPopover.Target>
        <EvaPopover.Dropdown>
          <div className="eva-ask-card" data-testid="ask-card">
            {ask.from !== undefined ? (
              <div className="eva-ask-card-from">{ask.from} asks</div>
            ) : null}
            <div>{ask.question}</div>
            <div className="eva-ask-card-actions">
              {ask.replies.map((reply) => (
                <Button
                  key={reply}
                  size="compact-sm"
                  variant="default"
                  onClick={() => {
                    setCard(false)
                    void resolveAsk(agent, ask, 'answered', reply)
                  }}
                >
                  {reply}
                </Button>
              ))}
              <Button
                size="compact-sm"
                variant="subtle"
                color="gray"
                onClick={() => {
                  setCard(false)
                  void resolveAsk(agent, ask, 'dismissed')
                }}
              >
                Dismiss
              </Button>
            </div>
          </div>
        </EvaPopover.Dropdown>
      </EvaPopover>
      {asks.length > 1 ? (
        <>
          <ActionIcon
            variant="subtle"
            size="var(--eva-kit-control-xs)"
            aria-label="Previous open ask"
            data-testid="ask-prev"
            onClick={() => step(-1)}
          >
            <IconChevronLeft size={14} stroke={1.5} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            size="var(--eva-kit-control-xs)"
            aria-label="Next open ask"
            data-testid="ask-next"
            onClick={() => step(1)}
          >
            <IconChevronRight size={14} stroke={1.5} />
          </ActionIcon>
        </>
      ) : null}
    </div>
  )
}
