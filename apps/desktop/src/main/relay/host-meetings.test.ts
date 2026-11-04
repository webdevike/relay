import { describe, expect, it } from 'vitest'
import { createHostMeetings } from './host-meetings'

type Frame = Record<string, unknown>

function frames(answer: (f: Frame) => Frame | null, up = true) {
  const listeners = new Set<(f: Frame) => void>()
  const sent: Frame[] = []
  return {
    sent,
    onFrame: (cb: (f: Frame) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    sendFrame: (f: Frame) => {
      if (!up) return false
      sent.push(f)
      const reply = answer(f)
      if (reply) queueMicrotask(() => [...listeners].forEach((cb) => cb(reply)))
      return true
    },
  }
}

describe('host meetings', () => {
  it('lists, answers ops by rid and carries the host error code', async () => {
    const link = frames((f) => {
      if (f.t === 'meetings.list')
        return { t: 'meetings.state', recordings: [], meetings: [], now: 1 }
      const op = f.op as { kind: string }
      if (op.kind === 'accept')
        return {
          t: 'meetings.res',
          rid: f.rid,
          ok: false,
          error: 'already accepted',
          code: 'not-proposed',
        }
      return { t: 'meetings.res', rid: f.rid, ok: true, detail: { meeting: null } }
    })
    const host = createHostMeetings(link)
    expect(await host.list()).toEqual({ recordings: [], meetings: [], now: 1 })
    expect(await host.req({ kind: 'get', stem: 's' })).toEqual({ detail: { meeting: null } })
    await expect(host.req({ kind: 'accept', stem: 's', proposalId: 'p' })).rejects.toMatchObject({
      message: 'already accepted',
      code: 'not-proposed',
    })
  })

  it('fails at once while not connected', async () => {
    const host = createHostMeetings(frames(() => null, false))
    await expect(host.req({ kind: 'open', id: 'x' })).rejects.toMatchObject({
      code: 'not_connected',
    })
  })
})
