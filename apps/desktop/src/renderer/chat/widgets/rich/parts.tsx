/**
 * Building blocks the rich widgets compose (widgets.rs shared helpers): title, pager with dots,
 * open-link icon, a media image with its quiet placeholder and error line, tone colors, and a
 * clock formatter for players.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ActionIcon, Group, Text, Tooltip, useMantineTheme } from '@mantine/core'
import { IconChevronLeft, IconChevronRight, IconExternalLink } from '@tabler/icons-react'
import type { Tone } from '@evaos/chat-core/widget'
import { openLink } from '../../../navigation/open-link'
import './rich.css'

const TONE_COLORS: Record<Exclude<Tone, 'accent'>, string> = {
  ok: 'green',
  warn: 'yellow',
  danger: 'red',
  muted: 'gray',
}

/** Mantine color for a tone: accent is the theme primary; no tone is neutral gray. */
export function useToneColor(): (tone: Tone | undefined) => string {
  const theme = useMantineTheme()
  return (tone) => {
    if (tone === undefined) return 'gray'
    return tone === 'accent' ? theme.primaryColor : TONE_COLORS[tone]
  }
}

export function WidgetTitle({ children }: { children: ReactNode }) {
  return (
    <Text className="eva-w-title" fw={600} size="sm">
      {children}
    </Text>
  )
}

/** Dots stop reading as a position past this many pages; a counter takes over. */
const MAX_DOTS = 10

/** Chevrons around page dots (or an "n / total" counter for long sets). Nothing for one page. */
export function Pager({
  index,
  count,
  onChange,
  label,
}: {
  index: number
  count: number
  onChange: (index: number) => void
  label: string
}) {
  if (count < 2) return null
  return (
    <Group gap={4} wrap="nowrap" className="eva-w-pager">
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={`Previous ${label}`}
        disabled={index === 0}
        onClick={() => onChange(index - 1)}
      >
        <IconChevronLeft size={16} stroke={1.75} />
      </ActionIcon>
      {count <= MAX_DOTS ? (
        <div className="eva-w-dots">
          {Array.from({ length: count }, (_, i) => (
            <button
              key={i}
              type="button"
              className="eva-w-dot"
              data-active={i === index}
              aria-label={`${label} ${i + 1} of ${count}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => onChange(i)}
            />
          ))}
        </div>
      ) : (
        <Text size="xs" c="dimmed" className="eva-w-counter">
          {index + 1} / {count}
        </Text>
      )}
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={`Next ${label}`}
        disabled={index === count - 1}
        onClick={() => onChange(index + 1)}
      >
        <IconChevronRight size={16} stroke={1.75} />
      </ActionIcon>
    </Group>
  )
}

/** A small icon button that opens `url` in the side browser. */
export function LinkIcon({ url, label = 'Open link' }: { url: string; label?: string }) {
  return (
    <Tooltip label={label} position="top">
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation()
          openLink(url)
        }}
      >
        <IconExternalLink size={14} stroke={1.75} />
      </ActionIcon>
    </Tooltip>
  )
}

type LoadState = 'loading' | 'ready' | 'error'

/**
 * An image filling its frame: transparent until it loads (the frame's muted surface is the
 * placeholder), and a short error line instead of a broken icon when it fails. `onAspect` reports
 * the natural width over height once known.
 */
export function MediaImage({
  src,
  alt,
  onAspect,
  className,
}: {
  src: string
  alt: string
  onAspect?: (aspect: number) => void
  className?: string
}) {
  const [state, setState] = useState<LoadState>('loading')
  useEffect(() => setState('loading'), [src])
  return (
    <div className={`eva-w-media ${className ?? ''}`} data-state={state}>
      {state === 'error' ? (
        <Text size="xs" c="dimmed" className="eva-w-media-error">
          Couldn&apos;t load image
        </Text>
      ) : (
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => {
            setState('ready')
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget
            if (w > 0 && h > 0) onAspect?.(w / h)
          }}
          onError={() => setState('error')}
        />
      )}
    </div>
  )
}

/** Seconds as m:ss (h:mm:ss past an hour); unknown reads 0:00. */
export function clock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
