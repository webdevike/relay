import { useEffect, useState, type ReactNode } from 'react'
import { notifications } from '@mantine/notifications'
import { IconBrandGithub, IconBrandSlack } from '@tabler/icons-react'
import { LinearMark } from '../chat/widgets/blocks/table'
import type { QueueSource } from './queue-search'

/** Per-item things only this app knows (files marked viewed), kept locally. */
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

/** The source's brand mark, small and monochrome, on queue rows and item headers. */
export function SourceMark({ source, size = 14 }: { source: QueueSource; size?: number }) {
  return (
    <span className="eva-rv-source" data-source={source} data-testid={`review-source-${source}`}>
      {source === 'github' ? (
        <IconBrandGithub size={size} stroke={1.75} aria-label="GitHub" />
      ) : source === 'linear' ? (
        <LinearMark size={size - 2} />
      ) : (
        <IconBrandSlack size={size} stroke={1.75} aria-label="Slack" />
      )}
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
