import { useEffect, useState, type ReactNode } from 'react'
import { notifications } from '@mantine/notifications'

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

export function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="eva-rv-rail-sec">
      <div className="eva-rv-rail-title">{title}</div>
      {children}
    </section>
  )
}
