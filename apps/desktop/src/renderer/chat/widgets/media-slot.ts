import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useActorRef, useSelector } from '@xstate/react'
import { fromCallback, type SnapshotFrom } from 'xstate'
import { MediaQueue } from './media-queue'
import { mediaSlotMachine, type MediaSlotEvent } from './media-slot.machine'

/**
 * Chat images and videos load newest first and only near the viewport (media-slot.machine.ts): a
 * reply with ten images starts four at a time, the newest message's first, and leaves the ones
 * scrolled far away as their sized frames. 3D models never load on their own: they open on a
 * click (rich/model-viewer.ts).
 */

/** The message's time (epoch ms) for the media inside it; newer loads first. */
export const MediaRank = createContext(0)

const QUEUE = new MediaQueue(4)

/** Within this distance of the visible chat, media asks to load (px). */
const NEAR_PX = 600

const machine = mediaSlotMachine.provide({
  actors: {
    ticket: fromCallback<MediaSlotEvent, { rank: number }>(({ sendBack, input }) =>
      QUEUE.enqueue(input.rank, () => sendBack({ type: 'slot.granted' })),
    ),
  },
})

type Watcher = (entry: IntersectionObserverEntry) => void

/** One observer for every media element; `scrollMargin` widens the chat scroller's clip too. */
const watchers = new Map<Element, Watcher>()
let observer: IntersectionObserver | null = null
function watchNear(el: Element, watcher: Watcher): () => void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) watchers.get(entry.target)?.(entry)
    },
    { rootMargin: `${NEAR_PX}px 0px`, scrollMargin: `${NEAR_PX}px 0px` },
  )
  watchers.set(el, watcher)
  observer.observe(el)
  return () => {
    watchers.delete(el)
    observer?.unobserve(el)
  }
}

const isLive = (s: SnapshotFrom<typeof machine>): boolean => s.hasTag('live')

/**
 * Whether this element's media may load now. Put `ref` on its sized frame, render the media only
 * while `live`, and call `settled` once it loaded or failed so the next one starts.
 */
export function useMediaSlot(): {
  ref: (el: Element | null) => void
  live: boolean
  settled: () => void
} {
  const rank = useContext(MediaRank)
  const actor = useActorRef(machine, { input: { rank } })
  const live = useSelector(actor, isLive)
  const [el, setEl] = useState<Element | null>(null)
  useEffect(() => {
    if (!el) return
    // No observer (jsdom): everything is near.
    if (typeof IntersectionObserver === 'undefined') {
      actor.send({ type: 'slot.near' })
      return
    }
    return watchNear(el, (e) => actor.send({ type: e.isIntersecting ? 'slot.near' : 'slot.away' }))
  }, [actor, el])
  const settled = useCallback(() => actor.send({ type: 'slot.settled' }), [actor])
  return { ref: setEl, live, settled }
}
