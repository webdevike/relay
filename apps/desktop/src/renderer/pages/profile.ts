import { useEffect, useState } from 'react'
import { invoke } from '../ipc'

export type Profile = 'eva' | 'starter'

/**
 * Pages a starter profile shows: the ones that need no Eva checkout. Overview is the dashboard,
 * which renders fine empty; Skills and Studio go through the Relay host (a "needs the host" state
 * without one).
 * Files and the boards under Dashboards show for every profile. Board, Feed, Reviews, Test Bench,
 * Jobs, Habits and Meetings read Eva's own folders and tools and stay Eva only.
 */
export const STARTER_SLUGS: Record<string, true> = {
  assistants: true,
  dashboard: true,
  chat: true,
  skills: true,
  canvas: true,
  studio: true,
  setting: true,
}

let memo: Promise<Profile> | null = null

/** The home base profile from `app.info`, read once; `eva` when main can't say. */
export function loadProfile(): Promise<Profile> {
  memo ??= invoke('app.info', {}).then((r) => (r.ok ? r.value.profile : 'eva'))
  return memo
}

/** `eva` until main says otherwise, so the full nav renders at once; flips once if starter. */
export function useProfile(): Profile {
  const [profile, setProfile] = useState<Profile>('eva')
  useEffect(() => {
    let cancelled = false
    void loadProfile().then((p) => {
      if (!cancelled) setProfile(p)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return profile
}
