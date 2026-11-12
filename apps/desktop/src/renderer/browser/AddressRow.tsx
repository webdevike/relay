import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Loader, Progress, TextInput, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconArrowLeft,
  IconArrowRight,
  IconCookie,
  IconCopy,
  IconExternalLink,
  IconLock,
  IconMessagePlus,
  IconRefresh,
  IconSearch,
  IconX,
} from '@tabler/icons-react'
import { NOTE_MARK_COLOR, type AnnotateMark, type TabState } from '@evaos/contract'
import { invoke, on } from '../ipc'
import { addressDisplay } from './address-display'
import { ImportArcModal } from './ImportArcModal'
import { ExtensionActions } from './ExtensionActions'
import { NoteComposer } from './NoteComposer'
import { Suggestions, type SuggestionItem } from './Suggestions'
import { browserStore, useBrowserStore } from './browser-store'

function Btn(props: {
  label: string
  testId: string
  disabled?: boolean
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip label={props.label} openDelay={400}>
      <ActionIcon
        variant={props.active ? 'light' : 'subtle'}
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

/**
 * Page `tabId`'s toolbar: back, forward, reload, the address field, its links and, for the
 * page the host has active, the extensions' actions (they act on the active page). `children`
 * end the row (the eCard app switch). While a note's mark is up the row is the note's composer.
 */
export function AddressRow({
  tabId,
  tab,
  visible,
  children,
}: {
  tabId: string
  tab: TabState | undefined
  visible: boolean
  children?: React.ReactNode
}) {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [items, setItems] = useState<SuggestionItem[]>([])
  const [active, setActive] = useState(-1)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const hostActive = useBrowserStore((s) => s.activeId === tabId)
  const wantFocus = useBrowserStore((s) => s.wantAddress === tabId)
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
    if (value.trim()) void invoke('browser.navigate', { tabId, input: value })
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
  // Not editing: host first, the rest dimmed (the input's own text hides under it).
  const display = addressDisplay(url)
  const shown = !editing && text === url ? display : null
  // A new blank page: its address field takes the focus once its tab shows.
  useEffect(() => {
    if (!wantFocus || !visible) return
    const frame = requestAnimationFrame(() => {
      input.current?.focus()
      browserStore.setState({ wantAddress: null })
    })
    return () => cancelAnimationFrame(frame)
  }, [wantFocus, visible])
  const act = (ch: 'back' | 'forward' | 'reload' | 'stop' | 'copyLink' | 'openExternal') => () => {
    void invoke(`browser.${ch}`, { tabId })
  }
  // Isaac marks something on the page, then writes a note here for the chat that owns it.
  const [noting, setNoting] = useState(false)
  const [mark, setMark] = useState<AnnotateMark | null>(null)
  const [sending, setSending] = useState(false)
  const noteSeq = useRef(0)
  const note = async (): Promise<void> => {
    const n = ++noteSeq.current
    setNoting(true)
    const r = await invoke('browser.annotate', { tabId })
    // A second click restarts the picker: the first one answers no mark and stays quiet.
    if (n !== noteSeq.current) return
    setNoting(false)
    if (r.ok) setMark(r.value.mark)
    else
      notifications.show({ color: 'red', message: `Could not mark the page: ${r.error.message}` })
  }
  const sendNote = async (text: string): Promise<void> => {
    setSending(true)
    const r = await invoke('browser.annotateSend', { tabId, text })
    setSending(false)
    setMark(null)
    if (!r.ok) {
      notifications.show({ color: 'red', message: `Could not send the note: ${r.error.message}` })
    } else if (r.value.sent) {
      notifications.show({ message: `Sent to ${r.value.to ?? 'the chat'}` })
    } else {
      notifications.show({
        message: r.value.to
          ? `Could not send the note to ${r.value.to}`
          : 'No chat owns this page, so the note was not sent',
      })
    }
  }
  const cancelNote = (): void => {
    setMark(null)
    void invoke('browser.annotateCancel', { tabId })
  }
  // A page closed with its note open takes the mark with it.
  const marked = useRef(false)
  useEffect(() => {
    marked.current = mark !== null
  }, [mark])
  useEffect(
    () => () => {
      if (marked.current) void invoke('browser.annotateCancel', { tabId })
    },
    [tabId],
  )
  // The page navigated under the mark: the note no longer points at what it shows.
  useEffect(
    () =>
      on('browser.annotateDropped', (p) => {
        if (p.tabId !== tabId || !marked.current) return
        setMark(null)
        notifications.show({ message: 'The page changed, so the note was dropped' })
      }),
    [tabId],
  )

  if (mark) {
    return (
      <NoteComposer
        mark={mark}
        color={tab?.agent?.color ?? NOTE_MARK_COLOR}
        sending={sending}
        onSend={(text) => void sendNote(text)}
        onCancel={cancelNote}
      />
    )
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
      <div className="eva-address-field">
        <TextInput
          ref={input}
          className="eva-address-input"
          size="xs"
          placeholder="Search, URL, or port such as 3000"
          aria-label="Address"
          data-testid="address-input"
          data-tab-id={tabId}
          data-display={shown ? true : undefined}
          value={text}
          leftSection={
            display?.secure ? (
              <IconLock className="eva-address-glyph" size={13} stroke={1.75} />
            ) : (
              <IconSearch className="eva-address-glyph" size={13} />
            )
          }
          onChange={(e) => {
            setText(e.currentTarget.value)
            ask(e.currentTarget.value)
          }}
          onBlur={() => {
            setEditing(false)
            close()
          }}
          onFocus={(e) => {
            setEditing(true)
            e.currentTarget.select()
          }}
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
        {shown ? (
          <span className="eva-address-display" aria-hidden data-testid="address-display">
            {shown.host}
            <span>{shown.rest}</span>
          </span>
        ) : null}
      </div>
      <Btn label="Copy link" testId="btn-copy-link" onClick={act('copyLink')}>
        <IconCopy size={16} />
      </Btn>
      <Btn label="Open in default browser" testId="btn-open-external" onClick={act('openExternal')}>
        <IconExternalLink size={16} />
      </Btn>
      <Btn
        label="Note for chat"
        testId="btn-annotate"
        disabled={!tab || tab.blank || tab.error !== null}
        active={noting}
        onClick={() => void note()}
      >
        <IconMessagePlus size={16} />
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
      {/* Extension actions act on the host's active page: the one last focused. */}
      {hostActive && tab ? <ExtensionActions /> : null}
      {children}
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
