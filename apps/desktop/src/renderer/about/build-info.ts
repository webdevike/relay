import { useEffect, useState } from 'react'
import { shortBuild, type AppAbout, type ChangelogEntry } from '@evaos/contract'
import { invoke } from '../ipc'

/** `Nov 3, 10:22 AM`: a date and time as Settings and the tooltip show them. */
export function formatStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** `Relay 31e5563 · Nov 3, 10:22 AM`, the sidebar logo's tooltip; a copy with no build id says so. */
export function brandTooltip(build: string | null, builtAt: string): string {
  return `Relay ${shortBuild(build) ?? 'dev'} · ${formatStamp(builtAt)}`
}

/** What About says about the connected host: `Isaac's Mac Mini 0.2.51`, or `Not connected`. */
export function hostLabel(about: Pick<AppAbout, 'hostName' | 'hostVersion'>): string {
  if (about.hostVersion === null) return about.hostName === null ? 'Not connected' : about.hostName
  return `${about.hostName ?? 'Relay Host'} ${about.hostVersion}`
}

/** `app.about`, read again every few seconds while the caller shows (the host connects late). */
export function useAbout(refreshMs = 0): AppAbout | null {
  const [about, setAbout] = useState<AppAbout | null>(null)
  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      void invoke('app.about', {}).then((r) => {
        if (!cancelled && r.ok) setAbout(r.value)
      })
    }
    read()
    const timer = refreshMs > 0 ? setInterval(read, refreshMs) : undefined
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refreshMs])
  return about
}

/** One day of the changelog: its heading and the entries made that day, newest first. */
export interface ChangelogDay {
  day: string
  entries: ChangelogEntry[]
}

const DAY = { weekday: 'long', month: 'long', day: 'numeric' } as const

/** Entries (already newest first) grouped by local calendar day, headed `Tuesday, November 3`. */
export function groupByDay(entries: readonly ChangelogEntry[]): ChangelogDay[] {
  const days: ChangelogDay[] = []
  for (const e of entries) {
    const day = new Date(e.at).toLocaleDateString('en-US', DAY)
    const last = days.at(-1)
    if (last?.day === day) last.entries.push(e)
    else days.push({ day, entries: [e] })
  }
  return days
}

/** The time of day an entry landed: `10:22 AM`. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
