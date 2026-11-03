import { useEffect, useState } from 'react'

const REDUCED = '(prefers-reduced-motion: reduce)'

export function resolveMotionOff(input: {
  e2e: boolean
  noMotion: boolean
  reducedMotion: boolean
}): boolean {
  return input.e2e || input.noMotion || input.reducedMotion
}

let playedThisLaunch = false
/** Named entrances (pages) that already played this launch; the shell uses the default key. */
const playedKeys = new Set<string>()
let motionOff = false
let mql: MediaQueryList | null = null
let handler: (() => void) | null = null

function setAttr(): void {
  document.documentElement.dataset['evaMotion'] = motionOff ? 'off' : 'on'
}

export function initMotion(info: { e2e: boolean; noMotion: boolean }): void {
  if (mql && handler) mql.removeEventListener('change', handler)
  mql = window.matchMedia(REDUCED)
  const compute = (): void => {
    motionOff = resolveMotionOff({
      e2e: info.e2e,
      noMotion: info.noMotion,
      reducedMotion: mql?.matches ?? false,
    })
    setAttr()
  }
  handler = compute
  mql.addEventListener('change', handler)
  compute()
}

/**
 * True for the first mount of the launch while motion is on. The flag flips in an effect,
 * not in the initializer, so StrictMode's double render still plays the entrance once.
 */
export function useEntrance(key?: string): boolean {
  const [play] = useState(() => !(key ? playedKeys.has(key) : playedThisLaunch) && !motionOff)
  useEffect(() => {
    if (key) playedKeys.add(key)
    else {
      playedThisLaunch = true
      document.documentElement.dataset['evaPlayed'] = 'true'
    }
  }, [key])
  return play
}

export function resetEntranceForTests(): void {
  playedThisLaunch = false
  playedKeys.clear()
  motionOff = false
  delete document.documentElement.dataset['evaPlayed']
}
