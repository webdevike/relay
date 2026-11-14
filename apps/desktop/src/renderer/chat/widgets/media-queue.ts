/**
 * Which chat media may start loading now: a priority queue with a concurrency limit. The highest
 * rank goes first (rank is the message's time, so the newest message wins), and among equal ranks
 * the later ask (the lower block of one reply). Grants wait a microtask, so every ask one scroll or
 * one commit makes is ranked before any of them is granted.
 */
interface Ask {
  rank: number
  seq: number
  grant: () => void
  state: 'waiting' | 'granted' | 'released'
}

export class MediaQueue {
  private readonly waiting: Ask[] = []
  private running = 0
  private seq = 0
  private scheduled = false

  constructor(readonly limit: number) {}

  /**
   * Asks for a slot: `grant` runs once one is free. Answers the release, which drops a waiting ask
   * or frees a granted slot for the next one; calling it again does nothing.
   */
  enqueue(rank: number, grant: () => void): () => void {
    const ask: Ask = { rank, seq: this.seq++, grant, state: 'waiting' }
    this.waiting.push(ask)
    this.schedule()
    return () => {
      if (ask.state === 'waiting') this.waiting.splice(this.waiting.indexOf(ask), 1)
      else if (ask.state === 'granted') {
        this.running--
        this.schedule()
      }
      ask.state = 'released'
    }
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.pump()
    })
  }

  private pump(): void {
    while (this.running < this.limit && this.waiting.length > 0) {
      let best = 0
      for (let i = 1; i < this.waiting.length; i++) {
        const a = this.waiting[i]!
        const b = this.waiting[best]!
        if (a.rank > b.rank || (a.rank === b.rank && a.seq > b.seq)) best = i
      }
      const ask = this.waiting.splice(best, 1)[0]!
      ask.state = 'granted'
      this.running++
      ask.grant()
    }
  }
}
