import { createEvaFs, type EvaFs } from '@evaos/eva-core'
import { makeClock } from '@evaos/eva-core/model/dates'
import type { MainContext } from '../context'

type Ctx = Pick<MainContext, 'env'>
type Clock = { now(): Date; today(): string }

const fsCache = new Map<string, EvaFs>()
const clockCache = new Map<string, Clock>()

/** The one EvaFs per Eva root; every write to the checkout goes through it. */
export function evaFsFor(ctx: Ctx): EvaFs {
  const root = ctx.env.evaRoot
  let fs = fsCache.get(root)
  if (!fs) {
    fs = createEvaFs({ root })
    fsCache.set(root, fs)
  }
  return fs
}

/** Clock shifted by EVAOS_NOW when set; memoized so the offset is stable per launch. */
export function clockFor(ctx: Ctx): Clock {
  const key = ctx.env.now ?? ''
  let clock = clockCache.get(key)
  if (!clock) {
    clock = makeClock(ctx.env.now)
    clockCache.set(key, clock)
  }
  return clock
}
