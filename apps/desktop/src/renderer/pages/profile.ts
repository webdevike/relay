import { useEffect, useState } from 'react'
import { invoke } from '../ipc'

export type Profile = 'eva' | 'starter'

/** Pages a starter profile shows (Overview is the dashboard, which renders fine empty). */
export const STARTER_SLUGS: Record<string, true> = {
  assistants: true,
  dashboard: true,
  chat: true,
  canvas: true,
  setting: true,
}

let memo: Promise<Profile> | null = null

/** The home base profile from `app.info`, read once; `eva` when main can't say. */
export function loadProfile(): Promise<Profile> {
  memo ??= invoke('app.info', {}).then((r) => (r.ok ? r.value.profile : 'eva'))
  return memo
}

/** null until main answers. */
export function useProfile(): Profile | null {
  const [profile, setProfile] = useState<Profile | null>(null)
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
