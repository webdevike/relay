import { useEffect, useRef, useState, type ReactNode } from 'react'
import { notifications } from '@mantine/notifications'
import { IconLock } from '@tabler/icons-react'
import { invoke } from '../ipc'
import { agoPhrase } from './review-model'

export interface PrivateAsk {
  text: string
  at: number
  status: 'sent' | 'dry-run'
}

/** Per-item things only this app knows (files marked viewed, private asks to Astra), kept locally. */
export function useLocal<T>(key: string | null, empty: T): [T, (v: T) => void] {
  const read = (): T => {
    if (!key) return empty
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : empty
    } catch {
      return empty
    }
  }
  const [value, setValue] = useState<T>(read)
  useEffect(() => setValue(read()), [key])
  return [
    value,
    (v: T) => {
      setValue(v)
      if (key) localStorage.setItem(key, JSON.stringify(v))
    },
  ]
}

export function fail(title: string, message: string): void {
  notifications.show({ title, message, color: 'red' })
}

/** Initials in a circle: GitHub and Linear avatars are remote images the shell does not load. */
export function Avatar({ login }: { login: string }) {
  return (
    <span className="eva-rv-avatar" title={login} aria-hidden>
      {login.slice(0, 1).toUpperCase()}
    </span>
  )
}

export function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="eva-rv-rail-sec">
      <div className="eva-rv-rail-title">{title}</div>
      {children}
    </section>
  )
}

/**
 * Sends a private @Astra question about an item to Astra's thread (never to GitHub or Linear) and
 * keeps it as a card on the item. Answers whether it went.
 */
export async function askAstra(
  item: { url: string; title: string },
  text: string,
  asks: PrivateAsk[],
  setAsks: (v: PrivateAsk[]) => void,
): Promise<boolean> {
  const r = await invoke('reviews.astra', { url: item.url, title: item.title, text })
  if (!r.ok) {
    fail("Couldn't reach Astra", r.error.message)
    return false
  }
  setAsks([...asks, { text, at: Date.now(), status: r.value.status }])
  notifications.show({
    message:
      r.value.status === 'sent'
        ? "Sent to Astra's thread."
        : `Test instance, not sent: ${r.value.command}`,
    color: r.value.status === 'sent' ? 'green' : 'gray',
  })
  return true
}

/** The private @Astra questions on an item; the newest scrolls into view when it is sent. */
export function PrivateAsks({
  asks,
  now,
  where,
}: {
  asks: PrivateAsk[]
  now: number
  /** `GitHub` or `Linear`: where the question is never posted. */
  where: string
}) {
  const last = useRef<HTMLDivElement>(null)
  const count = useRef(asks.length)
  useEffect(() => {
    if (asks.length > count.current) last.current?.scrollIntoView({ block: 'nearest' })
    count.current = asks.length
  }, [asks.length])
  return asks.map((a, i) => (
    <div
      key={i}
      ref={i === asks.length - 1 ? last : undefined}
      className="eva-rv-private"
      data-testid="review-private-ask"
    >
      <div className="eva-rv-private-head">
        <IconLock size={13} /> Private to Astra{' '}
        <span className="eva-rv-dim">{agoPhrase(a.at, now)}</span>
      </div>
      <div className="eva-rv-private-q">{a.text}</div>
      <div className="eva-rv-dim">
        {a.status === 'sent'
          ? `Sent to Astra's thread. Her answer arrives there, never on ${where}.`
          : 'Test instance: not sent to Astra.'}
      </div>
    </div>
  ))
}
