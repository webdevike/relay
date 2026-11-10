import { useEffect, useState } from 'react'
import { Tooltip, UnstyledButton } from '@mantine/core'
import { IconMessageQuestion } from '@tabler/icons-react'
import { EvaPopover } from '../../overlay'
import { AskLine } from '../minimap/TurnMinimap'
import { resolveAsk, useOpenAsks } from './asks-store'
import { jumpToAsk } from './ask-jump'
import '../../context/context.css'
import '../minimap/turn-minimap.css'

/**
 * The chat header's open-ask count, where the log is too narrow for the turn rail beside its text
 * (`turnRailFits`): it opens the same ask lines in a popover. A question jumps to its bubble; an
 * ask with no bubble to hold its answers (a session's question, an ask card) carries them here.
 */
export function AsksButton({ agent, paneId }: { agent: string; paneId: string }) {
  const asks = useOpenAsks(agent)
  const [open, setOpen] = useState(false)
  const count = asks.length
  useEffect(() => {
    if (count === 0) setOpen(false)
  }, [count])
  if (count === 0) return null
  return (
    <EvaPopover
      opened={open}
      onChange={setOpen}
      position="bottom-end"
      width={320}
      testid="asks-button-target"
    >
      <EvaPopover.Target>
        <Tooltip label="Waiting on you" position="bottom" openDelay={400} disabled={open}>
          <UnstyledButton
            className="eva-header-btn eva-ctx-btn eva-asks-btn"
            data-testid="asks-button"
            data-open={open ? 'true' : undefined}
            aria-label={`Waiting on you, ${count} open ${count === 1 ? 'ask' : 'asks'}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <IconMessageQuestion size={15} stroke={1.5} aria-hidden />
            <span className="eva-asks-count">{count}</span>
          </UnstyledButton>
        </Tooltip>
      </EvaPopover.Target>
      <EvaPopover.Dropdown>
        <div className="eva-asks-pop" data-testid="asks-popover">
          <div className="eva-asks-title">Waiting on you</div>
          {asks.map((ask) => (
            <AskLine
              key={ask.id}
              ask={ask}
              chips={ask.source !== 'replies'}
              onJump={(a) => {
                const jumped = jumpToAsk(paneId, a)
                if (jumped) setOpen(false)
                return jumped
              }}
              onResolve={(a, how, answer) => void resolveAsk(agent, a, how, answer)}
            />
          ))}
        </div>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
