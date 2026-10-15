import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Progress, TextInput, Tooltip } from '@mantine/core'
import {
  IconArrowLeft,
  IconArrowRight,
  IconCopy,
  IconExternalLink,
  IconRefresh,
  IconX,
} from '@tabler/icons-react'
import type { TabState } from '@evaos/contract'
import { invoke } from '../ipc'

function Btn(props: {
  label: string
  testId: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip label={props.label} openDelay={400}>
      <ActionIcon
        variant="subtle"
        size={28}
        aria-label={props.label}
        data-testid={props.testId}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.children}
      </ActionIcon>
    </Tooltip>
  )
}

export function AddressRow({ tab }: { tab: TabState | undefined }) {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const url = tab?.url ?? ''
  useEffect(() => setText(url), [url])
  const tabId = tab?.id
  const act = (ch: 'back' | 'forward' | 'reload' | 'stop' | 'copyLink' | 'openExternal') => () => {
    if (tabId) void invoke(`browser.${ch}`, { tabId })
  }

  return (
    <div className="eva-address-row" data-testid="address-row">
      <Btn label="Back" testId="nav-back" disabled={!tab?.canGoBack} onClick={act('back')}>
        <IconArrowLeft size={16} />
      </Btn>
      <Btn
        label="Forward"
        testId="nav-forward"
        disabled={!tab?.canGoForward}
        onClick={act('forward')}
      >
        <IconArrowRight size={16} />
      </Btn>
      <Btn
        label={tab?.loading ? 'Stop' : 'Reload'}
        testId="nav-reload"
        onClick={act(tab?.loading ? 'stop' : 'reload')}
      >
        {tab?.loading ? <IconX size={16} /> : <IconRefresh size={16} />}
      </Btn>
      <TextInput
        ref={input}
        className="eva-address-input"
        size="xs"
        placeholder="Search or enter address"
        aria-label="Address"
        data-testid="address-input"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && tabId) {
            void invoke('browser.navigate', { tabId, input: text })
          } else if (e.key === 'Escape') {
            setText(url)
            input.current?.blur()
          }
        }}
      />
      <Btn label="Copy link" testId="btn-copy-link" onClick={act('copyLink')}>
        <IconCopy size={16} />
      </Btn>
      <Btn label="Open in default browser" testId="btn-open-external" onClick={act('openExternal')}>
        <IconExternalLink size={16} />
      </Btn>
      {/* Plan 01-09 adds the Import Arc logins button after this point. */}
      {tab?.loading ? (
        <Progress className="eva-address-progress" value={100} animated size={2} radius={0} />
      ) : null}
    </div>
  )
}
