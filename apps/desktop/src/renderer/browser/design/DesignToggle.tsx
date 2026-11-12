import { ActionIcon, Tooltip } from '@mantine/core'
import { IconPointer } from '@tabler/icons-react'
import { useSelector } from '@xstate/react'
import type { TabState } from '@evaos/contract'
import { designActorOf } from './design-runtime'

/** The address row's Design Mode switch for page `tabId` (off on blank and error pages). */
export function DesignToggle({ tabId, tab }: { tabId: string; tab: TabState | undefined }) {
  const actor = designActorOf(tabId)
  const on = useSelector(actor, (s) => s.matches('on') || s.matches('starting'))
  const busy = useSelector(actor, (s) => s.matches('starting') || s.matches('stopping'))
  const usable = tab !== undefined && !tab.blank && tab.error === null
  const label = on ? 'Exit design mode' : 'Design mode: pick elements to change'
  return (
    <Tooltip label={label} openDelay={400}>
      <ActionIcon
        variant={on ? 'light' : 'subtle'}
        size={28}
        aria-label={label}
        aria-pressed={on}
        data-testid="btn-design-mode"
        disabled={(!usable && !on) || busy}
        onClick={() => actor.send({ type: 'design.toggle' })}
      >
        <IconPointer size={16} />
      </ActionIcon>
    </Tooltip>
  )
}
