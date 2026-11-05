import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import {
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconSparkles,
  IconUser,
  IconX,
} from '@tabler/icons-react'
import type { Pin } from '@evaos/chat-core/pins'
import { AgentPortrait } from '../assistants/AgentPortrait'
import { agentOf, useAssistants } from '../assistants/assistants-store'
import { showPath } from '../files/files-store'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { openTargetOf } from '../navigation/open-target'
import { revealTool } from '../tiling/tiling-store'
import type { PinsScopeValue } from './pins-scope'
import './pins.css'

const ICON = { size: 14, stroke: 1.5 } as const
/** How long a Copy button keeps its check. */
export const COPIED_MS = 1400

/** Copies `text`; false when the clipboard refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Where Open on a pin goes: a web link (links, PRs, tickets), a file, or nowhere. */
function openKind(pin: Pin): 'link' | 'file' | null {
  if (pin.kind === 'file')
    return pin.value.startsWith('/') || pin.value.startsWith('~') ? 'file' : null
  if (pin.kind === 'link' || pin.kind === 'pr' || pin.kind === 'item') {
    return /^https?:\/\//.test(pin.value) ? 'link' : null
  }
  return null
}

/** A quiet who-pinned mark: Isaac's disc, an assistant's portrait, else a spark for a chat. */
export function PinnedBy({ by }: { by: string }) {
  const title = useAssistants((s) => agentOf(s, by)?.title ?? null)
  const who = by === 'isaac' ? 'Isaac' : (title ?? by)
  return (
    <Tooltip label={`Pinned by ${who}`} openDelay={300} position="top">
      <span
        className="eva-pin-by"
        data-by={by === 'isaac' ? 'isaac' : 'assistant'}
        role="img"
        aria-label={`Pinned by ${who}`}
      >
        {by === 'isaac' ? (
          <IconUser {...ICON} />
        ) : title !== null ? (
          <AgentPortrait id={by} className="eva-pin-portrait" />
        ) : (
          <IconSparkles {...ICON} />
        )}
      </span>
    </Tooltip>
  )
}

/** One pin: label (scrolls to its message), the value, Copy, Open, who pinned it and an unpin x. */
export function PinRow({
  pin,
  scope,
  onOpened,
}: {
  pin: Pin
  scope: PinsScopeValue
  onOpened?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const open = openKind(pin)
  const mono = pin.kind === 'code' || pin.kind === 'number'
  const copy = async (): Promise<void> => {
    if (!(await copyText(pin.value))) return
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
  }
  const openIt = (e: MouseEvent): void => {
    if (open === 'file') {
      revealTool('files')
      void showPath(pin.value, scope.file || null)
    } else if (e.altKey) {
      void invoke('artifacts.openExternal', { url: pin.value })
    } else {
      openLink(pin.value, { target: openTargetOf(e) })
    }
    onOpened?.()
  }
  return (
    <div
      className="eva-pin"
      data-kind={pin.kind}
      data-copied={copied ? 'true' : undefined}
      data-testid={`pin-${pin.id}`}
    >
      <div className="eva-pin-head">
        {pin.source !== undefined ? (
          <button
            type="button"
            className="eva-pin-label"
            title="Show the message"
            data-testid="pin-label"
            onClick={() => {
              scope.reveal(pin.source!)
              onOpened?.()
            }}
          >
            {pin.label}
          </button>
        ) : (
          <span className="eva-pin-label" data-static data-testid="pin-label">
            {pin.label}
          </span>
        )}
        <PinnedBy by={pin.pinnedBy} />
      </div>
      <div className="eva-pin-body">
        <div
          className="eva-pin-value"
          data-mono={mono ? 'true' : undefined}
          data-same={pin.value === pin.label || pin.kind === 'message' ? 'true' : undefined}
          title={pin.value}
          data-testid="pin-value"
        >
          {pin.value}
        </div>
        <div className="eva-pin-actions">
          <Tooltip label={copied ? 'Copied' : 'Copy'} openDelay={300} position="top">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={copied ? 'Copied' : `Copy ${pin.label}`}
              data-testid="pin-copy"
              onClick={() => void copy()}
            >
              {copied ? <IconCheck {...ICON} /> : <IconCopy {...ICON} />}
            </ActionIcon>
          </Tooltip>
          {open !== null ? (
            <Tooltip
              label={open === 'file' ? 'Open in Files' : 'Open (Option: in Arc)'}
              openDelay={300}
              position="top"
            >
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={`Open ${pin.label}`}
                data-testid="pin-open"
                onClick={openIt}
                onAuxClick={(e) => {
                  if (e.button === 1) openIt(e)
                }}
              >
                <IconExternalLink {...ICON} />
              </ActionIcon>
            </Tooltip>
          ) : null}
          <Tooltip label="Unpin" openDelay={300} position="top" disabled={!scope.up}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`Unpin ${pin.label}`}
              data-testid="pin-unpin"
              disabled={!scope.up}
              onClick={() => scope.unpin(pin.id)}
            >
              <IconX {...ICON} />
            </ActionIcon>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

/** The pins as flat rows on hairline dividers: the rail's body and the popover's. */
export function PinsList({ scope, onOpened }: { scope: PinsScopeValue; onOpened?: () => void }) {
  return (
    <div className="eva-pins-list" data-testid="pins-list">
      {scope.pins.map((pin) => (
        <PinRow
          key={pin.id}
          pin={pin}
          scope={scope}
          {...(onOpened === undefined ? {} : { onOpened })}
        />
      ))}
    </div>
  )
}
