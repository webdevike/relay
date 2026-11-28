import { describe, expect, it } from 'vitest'
import { createActor, fromPromise, waitFor } from 'xstate'
import {
  NOT_DELIVERED,
  assistantAskMachine,
  type AskInput,
  type AskProgress,
  type SendResult,
} from './assistant-ask.machine'

const WORKING: AskProgress = { working: true, answered: false, error: null }
const DONE: AskProgress = { working: false, answered: true, error: null }

type AskState =
  'idle' | 'sending' | 'answering' | 'answered' | 'failed' | 'interrupted' | 'restoring'

function start(o: { sends?: Array<SendResult | Error>; restore?: AskProgress | null } = {}) {
  const sent: AskInput[] = []
  const sends = [...(o.sends ?? [])]
  const machine = assistantAskMachine.provide({
    actors: {
      send: fromPromise(async ({ input }: { input: AskInput }) => {
        sent.push(input)
        const next = sends.shift() ?? { kind: 'sent', progress: WORKING }
        if (next instanceof Error) throw next
        return next
      }),
      restore: fromPromise(async () => o.restore ?? null),
    },
  })
  const actor = createActor(machine).start()
  const at = (state: AskState) => waitFor(actor, (s) => s.matches(state))
  return { actor, sent, at }
}

describe('assistantAskMachine', () => {
  it('an ask goes out, she answers, and her turn ending settles it', async () => {
    const { actor, sent, at } = start()
    actor.send({ type: 'ask.send', text: '@Astra what is left?' })
    await at('answering')
    expect(sent).toEqual([{ text: '@Astra what is left?', thread: null }])
    actor.send({ type: 'ask.update', progress: { ...WORKING, answered: true } })
    expect(actor.getSnapshot().value).toBe('answering')
    actor.send({ type: 'ask.update', progress: DONE })
    expect(actor.getSnapshot().value).toBe('answered')
    expect(actor.getSnapshot().can({ type: 'ask.retry' })).toBe(false)
  })

  it('a follow-up continues the same thread; one naming another thread goes there', async () => {
    const { actor, sent, at } = start({ sends: [{ kind: 'sent', progress: DONE }] })
    actor.send({ type: 'ask.send', text: 'first' })
    await at('answered')
    actor.send({ type: 'ask.followUp', text: 'and then?' })
    await at('answering')
    actor.send({ type: 'ask.update', progress: DONE })
    actor.send({ type: 'ask.followUp', text: 'back there', thread: 'older' })
    await waitFor(actor, () => sent.length === 3)
    expect(sent.slice(1)).toEqual([
      { text: 'and then?', thread: 'first' },
      { text: 'back there', thread: 'older' },
    ])
    expect(actor.getSnapshot().context.thread).toBe('older')
  })

  it('an ask that did not go out fails; Retry sends the same text again', async () => {
    const { actor, sent, at } = start({
      sends: [{ kind: 'failed', message: 'Couldn’t reach Nova' }, new Error('boom')],
    })
    actor.send({ type: 'ask.send', text: 'hi' })
    await at('failed')
    expect(actor.getSnapshot().context.error).toBe('Couldn’t reach Nova')
    actor.send({ type: 'ask.retry' })
    await waitFor(actor, () => sent.length === 2)
    await at('failed')
    expect(actor.getSnapshot().context.error).toBe(NOT_DELIVERED)
    actor.send({ type: 'ask.retry' })
    await at('answering')
    expect(sent.map((s) => s.text)).toEqual(['hi', 'hi', 'hi'])
  })

  it('her session failing before any text fails the ask', async () => {
    const { actor, at } = start()
    actor.send({ type: 'ask.send', text: 'hi' })
    await at('answering')
    actor.send({
      type: 'ask.update',
      progress: { working: false, answered: false, error: 'omp exited' },
    })
    expect(actor.getSnapshot().value).toBe('failed')
    expect(actor.getSnapshot().context.error).toBe('omp exited')
  })

  it('a lost connection interrupts; on reconnect the thread snapshot restores where she is', async () => {
    const working = start({ restore: WORKING })
    working.actor.send({ type: 'ask.send', text: 'hi' })
    await working.at('answering')
    working.actor.send({ type: 'ask.disconnected' })
    expect(working.actor.getSnapshot().value).toBe('interrupted')
    working.actor.send({ type: 'ask.update', progress: DONE })
    expect(working.actor.getSnapshot().value).toBe('interrupted')
    working.actor.send({ type: 'ask.reconnected' })
    await working.at('answering')

    const answered = start({ sends: [{ kind: 'lost' }], restore: DONE })
    answered.actor.send({ type: 'ask.send', text: 'hi' })
    await answered.at('interrupted')
    answered.actor.send({ type: 'ask.reconnected' })
    await answered.at('answered')
    expect(answered.sent).toHaveLength(1)

    const never = start({ sends: [{ kind: 'lost' }], restore: null })
    never.actor.send({ type: 'ask.send', text: 'hi' })
    await never.at('interrupted')
    never.actor.send({ type: 'ask.reconnected' })
    await never.at('failed')
    expect(never.actor.getSnapshot().can({ type: 'ask.retry' })).toBe(true)
  })
})
