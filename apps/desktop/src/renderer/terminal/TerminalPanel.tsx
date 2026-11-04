import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionIcon, Button, Tooltip } from '@mantine/core'
import { IconPlugConnected, IconPlus, IconTerminal2, IconX } from '@tabler/icons-react'
import type { TerminalMode } from '@evaos/contract'
import { useChatStore } from '../chat/chat-store'
import { useFrontChatPane } from '../chat/front-chat'
import { invoke } from '../ipc'
import { TerminalView } from './TerminalView'
import { takeWatchRequest, useWatchRequest } from './terminal-watch'
import './terminal.css'

interface TerminalTab {
  key: number
  mode: TerminalMode
  /** The chat this terminal was opened for. */
  file: string | null
  title: string
  /** A herdr pane shown view-only (a harness from the Working tab); the chat file is not used. */
  watch?: string
}

const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

/**
 * The Terminal tool: shells in the open chat's folder and, for a chat running in herdr, that
 * session's live TUI. Every terminal stays mounted (and its process alive) while the tab exists;
 * closing the Terminal tab or a terminal ends its pty.
 */
export function TerminalPanel({ hidden }: { hidden: boolean }) {
  const front = useFrontChatPane()
  const chatFile = useChatStore((s) => s.panes[front]?.file || null)
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [active, setActive] = useState<number | null>(null)
  const [pane, setPane] = useState<string | null>(null)
  const seq = useRef(0)
  const opened = useRef(false)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  const open = useCallback((mode: TerminalMode, file: string | null) => {
    const key = ++seq.current
    const title = mode === 'attach' ? 'herdr' : 'Shell'
    setTabs((t) => [...t, { key, mode, file, title }])
    setActive(key)
  }, [])

  const close = useCallback((key: number) => {
    const list = tabsRef.current
    const i = list.findIndex((t) => t.key === key)
    if (i < 0) return
    const rest = list.filter((t) => t.key !== key)
    setTabs(rest)
    setActive((a) => (a === key ? (rest[Math.min(i, rest.length - 1)]?.key ?? null) : a))
  }, [])

  // A harness the Working tab asked for opens view-only, and then no spare shell opens beside it.
  const request = useWatchRequest()
  useEffect(() => {
    if (request === null) return
    opened.current = true
    const key = ++seq.current
    setTabs((t) => {
      const have = t.find((x) => x.watch === request.pane)
      if (have) {
        setActive(have.key)
        return t
      }
      setActive(key)
      return [...t, { key, mode: 'attach', file: null, title: `${request.title} (view only)`, watch: request.pane }]
    })
    takeWatchRequest()
  }, [request])

  // The first time the tool shows, it opens a shell.
  useEffect(() => {
    if (hidden || opened.current) return
    opened.current = true
    open('shell', chatFile)
  }, [hidden, chatFile, open])

  // Whether the open chat runs in herdr, so its session can be attached to.
  useEffect(() => {
    if (hidden) return
    let stale = false
    void invoke('terminal.attachable', { file: chatFile }).then((r) => {
      if (!stale) setPane(r.ok ? r.value.pane : null)
    })
    return () => {
      stale = true
    }
  }, [hidden, chatFile])

  const attached = tabs.find((t) => t.mode === 'attach' && t.watch === undefined && t.file === chatFile)
  const attach = (): void => {
    if (attached) setActive(attached.key)
    else open('attach', chatFile)
  }

  return (
    <div className="eva-terminal" hidden={hidden} data-testid="terminal-panel">
      <div className="eva-terminal-tabs">
        <div className="eva-terminal-tabs-scroll" role="tablist">
          {tabs.map((t) => (
            <div
              key={t.key}
              role="tab"
              aria-selected={t.key === active}
              className="eva-terminal-tab"
              data-active={t.key === active || undefined}
              data-testid="terminal-tab"
              title={t.title}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  close(t.key)
                } else if (e.button === 0) setActive(t.key)
              }}
            >
              {t.mode === 'attach' ? (
                <IconPlugConnected size={14} stroke={1.5} />
              ) : (
                <IconTerminal2 size={14} stroke={1.5} />
              )}
              <span className="eva-terminal-tab-name">{t.title}</span>
              <button
                type="button"
                className="eva-terminal-tab-close"
                aria-label={`Close ${t.title}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => close(t.key)}
              >
                <IconX size={12} stroke={2} />
              </button>
            </div>
          ))}
        </div>
        <div className="eva-terminal-tabs-actions">
          <Tooltip label="New terminal" openDelay={400}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="New terminal"
              data-testid="terminal-new"
              onClick={() => open('shell', chatFile)}
            >
              <IconPlus size={14} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
          {pane !== null ? (
            <Tooltip label="Attach to this chat's herdr session" openDelay={400}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Attach to session"
                data-testid="terminal-attach"
                onClick={attach}
              >
                <IconPlugConnected size={14} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <div className="eva-terminal-body">
        {tabs.map((t) => (
          <div key={t.key} className="eva-terminal-slot" hidden={t.key !== active}>
            <TerminalView
              file={t.file}
              mode={t.mode}
              {...(t.watch === undefined ? {} : { watch: t.watch })}
              active={!hidden && t.key === active}
              onSpawn={({ cwd, title }) =>
                setTabs((list) =>
                  list.map((x) =>
                    x.key === t.key
                      ? {
                          ...x,
                          title:
                            t.watch !== undefined
                              ? x.title
                              : t.mode === 'attach'
                                ? `${title} ${baseName(cwd)}`
                                : baseName(cwd),
                        }
                      : x,
                  ),
                )
              }
              onExit={() => close(t.key)}
            />
          </div>
        ))}
        {tabs.length === 0 ? (
          <div className="eva-terminal-empty">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconTerminal2 size={14} stroke={1.5} />}
              onClick={() => open('shell', chatFile)}
            >
              New terminal
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
