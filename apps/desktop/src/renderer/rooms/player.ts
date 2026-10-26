import { compileBeats, type Beat, type Step } from './fixture'
import { nextId, post, resolve, setTyping, toggleReaction } from './rooms-store'
import { ISAAC } from './types'

export interface Player {
  start(): void
  stop(): void
  /** Posts Isaac's message, then injects a scripted reply before the script continues. */
  isaacPosts(text: string): void
}

/** Gap after an injected reply before the paused script resumes. */
const RESUME_GAP_MS = 600

/**
 * Replays a script into one room on real timers. Pending steps keep their spacing: when Isaac
 * posts, a reply set is inserted at the current time and everything after it shifts by its span.
 */
export function createPlayer(
  roomId: string,
  script: readonly Step[],
  replies: readonly (readonly Beat[])[],
): Player {
  let pending: Step[] = []
  let base = 0
  let timer: number | undefined
  let running = false
  let replyCount = 0

  const elapsed = (): number => Date.now() - base

  const apply = (op: Step['op']): void => {
    switch (op.type) {
      case 'typing':
        setTyping(roomId, op.agent, op.on)
        return
      case 'message':
        post(roomId, {
          id: `${roomId}:${op.key}`,
          author: op.author,
          text: op.text,
          ts: Date.now(),
          reactions: [],
          kind: 'message',
        })
        return
      case 'reaction':
        toggleReaction(roomId, `${roomId}:${op.key}`, op.emoji, op.by)
        return
      case 'resolve':
        resolve(roomId, {
          id: `${roomId}:${op.key}`,
          author: op.author,
          text: op.text,
          ts: Date.now(),
          reactions: [],
          kind: 'summary',
        })
        return
    }
  }

  const schedule = (): void => {
    clearTimeout(timer)
    timer = undefined
    if (!running || pending.length === 0) return
    timer = window.setTimeout(tick, Math.max(0, pending[0]!.at - elapsed()))
  }

  const tick = (): void => {
    timer = undefined
    const now = elapsed()
    while (pending.length > 0 && pending[0]!.at <= now) apply(pending.shift()!.op)
    schedule()
  }

  return {
    start() {
      if (running) return
      running = true
      base = Date.now()
      pending = script.map((s) => ({ ...s }))
      schedule()
    },
    stop() {
      running = false
      pending = []
      clearTimeout(timer)
      timer = undefined
    },
    isaacPosts(text) {
      post(roomId, {
        id: nextId('msg'),
        author: ISAAC,
        text,
        ts: Date.now(),
        reactions: [],
        kind: 'message',
      })
      if (!running || replies.length === 0) return
      const set = replies[replyCount % replies.length]!
      const n = ++replyCount
      const now = elapsed()
      const inserted = compileBeats(
        set.map((b) => ({ ...b, key: `${b.key}-${n}` })),
        now,
      )
      const span = inserted[inserted.length - 1]!.at - now + RESUME_GAP_MS
      for (const s of pending) s.at += span
      pending = [...inserted, ...pending].sort((a, b) => a.at - b.at)
      schedule()
    },
  }
}
