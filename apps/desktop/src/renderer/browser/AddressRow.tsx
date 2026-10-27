import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Loader, Progress, TextInput, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconArrowLeft,
  IconArrowRight,
  IconCookie,
  IconCopy,
  IconExternalLink,
  IconRefresh,
  IconX,
} from '@tabler/icons-react'
import type { TabState } from '@evaos/contract'
import { invoke } from '../ipc'
import { ImportArcModal } from './ImportArcModal'
import { ExtensionActions } from './ExtensionActions'
import { Suggestions, type SuggestionItem } from './Suggestions'

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
  const [items, setItems] = useState<SuggestionItem[]>([])
  const [active, setActive] = useState(-1)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const close = (): void => {
    seq.current++
    if (timer.current) clearTimeout(timer.current)
    setItems([])
    setActive(-1)
  }
  const ask = (value: string): void => {
    if (timer.current) clearTimeout(timer.current)
    const n = ++seq.current
    if (!value.trim()) {
      setItems([])
      return
    }
    timer.current = setTimeout(() => {
      void invoke('browser.suggest', { text: value }).then((r) => {
        if (n !== seq.current || !r.ok) return
        setItems(r.value.items)
        setActive(-1)
      })
    }, 60)
  }
  const go = (value: string): void => {
    close()
    // A scope with no tabs opens its first one from the address bar.
    if (tabId) void invoke('browser.navigate', { tabId, input: value })
    else if (value.trim()) void invoke('browser.createTab', { url: value })
    input.current?.blur()
  }
  const runImport = async (): Promise<void> => {
    setImportOpen(false)
    setImporting(true)
    try {
      const r = await invoke('browser.importArc', {})
      if (r.ok) {
        notifications.show({
          message: `Imported ${r.value.count} logins. Reloading the page.`,
          autoClose: 5000,
        })
      } else {
        notifications.show({
          color: 'red',
          message: `Could not import Arc logins: ${r.error.message}. Check that Arc is installed and allow Keychain access, then try again.`,
          autoClose: 8000,
        })
      }
    } finally {
      setImporting(false)
    }
  }
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
        onChange={(e) => {
          setText(e.currentTarget.value)
          ask(e.currentTarget.value)
        }}
        onBlur={close}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && items.length) {
            e.preventDefault()
            setActive((a) => (a + 1) % items.length)
          } else if (e.key === 'ArrowUp' && items.length) {
            e.preventDefault()
            setActive((a) => (a <= 0 ? items.length - 1 : a - 1))
          } else if (e.key === 'Enter') {
            go(active >= 0 && items[active] ? items[active].url : text)
          } else if (e.key === 'Escape') {
            if (items.length) close()
            else {
              setText(url)
              input.current?.blur()
            }
          }
        }}
      />
      <Btn label="Copy link" testId="btn-copy-link" onClick={act('copyLink')}>
        <IconCopy size={16} />
      </Btn>
      <Btn label="Open in default browser" testId="btn-open-external" onClick={act('openExternal')}>
        <IconExternalLink size={16} />
      </Btn>
      <Suggestions items={items} active={active} onPick={(it) => go(it.url)} />
      <Tooltip label="Import Arc logins" openDelay={400}>
        <ActionIcon
          variant="subtle"
          size={28}
          aria-label="Import Arc logins"
          data-testid="btn-import-arc"
          disabled={importing}
          onClick={() => setImportOpen(true)}
        >
          {importing ? <Loader size={14} /> : <IconCookie size={16} />}
        </ActionIcon>
      </Tooltip>
      {/* Extension actions act on the active tab; a scope with no tabs has none to offer. */}
      {tab ? <ExtensionActions /> : null}
      <ImportArcModal
        opened={importOpen}
        onConfirm={() => void runImport()}
        onCancel={() => setImportOpen(false)}
      />
      {tab?.loading ? (
        <Progress className="eva-address-progress" value={100} animated size={2} radius={0} />
      ) : null}
    </div>
  )
}
