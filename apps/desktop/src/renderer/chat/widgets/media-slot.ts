import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useActorRef, useSelector } from '@xstate/react'
import { fromCallback, type SnapshotFrom } from 'xstate'
import { MediaQueue } from './media-queue'
import { mediaSlotMachine, type MediaLane, type MediaSlotEvent } from './media-slot.machine'

/**
 * Chat media loads newest first and only near the viewport (media-slot.machine.ts): a reply with
 * ten 3D models and a few images starts two models and four images at a time, the newest message's
 * first, and leaves the ones scrolled far away as their sized frames. A 3D viewer far off screen
 * gives its WebGL context back.
 */

/** The message's time (epoch ms) for the media inside it; newer loads first. */
export const MediaRank = createContext(0)

/** GLBs are heavy (a download, a parse, a WebGL context): two at a time. */
const QUEUES: Record<MediaLane, MediaQueue> = { model: new MediaQueue(2), media: new MediaQueue(4) }

/** Within this distance of the visible chat, media asks to load (px). */
const NEAR_PX = 600
/** Beyond this distance, a 3D viewer unloads (px). */
const FAR_PX = 2400

const machine = mediaSlotMachine.provide({
  actors: {
    ticket: fromCallback<MediaSlotEvent, { lane: MediaLane; rank: number }>(({ sendBack, input }) =>
      QUEUES[input.lane].enqueue(input.rank, () => sendBack({ type: 'slot.granted' })),
    ),
  },
})

type Watcher = (entry: IntersectionObserverEntry) => void

/** One observer per margin for every media element; `scrollMargin` widens the chat scroller's clip too. */
function sharedObserver(px: number) {
  const watchers = new Map<Element, Watcher>()
  let observer: IntersectionObserver | null = null
  return (el: Element, watcher: Watcher): (() => void) => {
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) watchers.get(entry.target)?.(entry)
      },
      { rootMargin: `${px}px 0px`, scrollMargin: `${px}px 0px` },
    )
    watchers.set(el, watcher)
    observer.observe(el)
    return () => {
      watchers.delete(el)
      observer?.unobserve(el)
    }
  }
}

const watchNear = sharedObserver(NEAR_PX)
const watchFar = sharedObserver(FAR_PX)

const isLive = (s: SnapshotFrom<typeof machine>): boolean => s.hasTag('live')

/**
 * Whether this element's media may load now. Put `ref` on its sized frame, render the media only
 * while `live`, and call `settled` once it loaded or failed so the next one starts.
 */
export function useMediaSlot(
  lane: MediaLane,
  evict = false,
): { ref: (el: Element | null) => void; live: boolean; settled: () => void } {
  const rank = useContext(MediaRank)
  const actor = useActorRef(machine, { input: { lane, rank, evict } })
  const live = useSelector(actor, isLive)
  const [el, setEl] = useState<Element | null>(null)
  useEffect(() => {
    if (!el) return
    // No observer (jsdom): everything is near.
    if (typeof IntersectionObserver === 'undefined') {
      actor.send({ type: 'slot.near' })
      return
    }
    const stopNear = watchNear(el, (e) =>
      actor.send({ type: e.isIntersecting ? 'slot.near' : 'slot.away' }),
    )
    const stopFar = watchFar(el, (e) => {
      if (!e.isIntersecting) actor.send({ type: 'slot.far' })
    })
    return () => {
      stopNear()
      stopFar()
    }
  }, [actor, el])
  const settled = useCallback(() => actor.send({ type: 'slot.settled' }), [actor])
  return { ref: setEl, live, settled }
}
