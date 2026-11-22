import { describe, expect, it } from 'vitest'
import { createActor, fromCallback, fromPromise, waitFor, type ActorRefFrom } from 'xstate'
import { MODEL_MAX_BYTES } from '@evaos/chat-core/model-limit'
import { modelViewerMachine, type ModelInfo, type ModelViewerEvent } from './model-viewer.machine'
import { claimOpenModel, releaseOpenModel } from './open-model'

type Viewer = ActorRefFrom<typeof modelViewerMachine>

/**
 * One Model block with stubbed effects: `info` answers `info`, the scene logs its mounts and
 * teardowns and hands out `report` to answer as the loader, claim/release use the real registry.
 */
function viewer(name: string, info: ModelInfo, log: string[]) {
  let report: (event: ModelViewerEvent) => void = () => {}
  let self: Viewer | null = null
  const close = () => self?.send({ type: 'viewer.close' })
  const machine = modelViewerMachine.provide({
    actions: {
      claim: () => claimOpenModel(close),
      release: () => releaseOpenModel(close),
    },
    actors: {
      info: fromPromise<ModelInfo>(() => Promise.resolve(info)),
      scene: fromCallback<ModelViewerEvent>(({ sendBack }) => {
        log.push(`${name} mount`)
        report = sendBack
        return () => log.push(`${name} dispose`)
      }),
    },
  })
  const actor: Viewer = createActor(machine).start()
  self = actor
  // Like the widget unmounting: a stopped actor runs no exit actions.
  const stop = () => {
    releaseOpenModel(close)
    actor.stop()
  }
  return { actor, stop, report: (event: ModelViewerEvent) => report(event) }
}

const view = (a: Viewer) => JSON.stringify(a.getSnapshot().value)
const small: ModelInfo = { size: 14 * 1024 * 1024, name: 'scan.glb' }

describe('modelViewerMachine', () => {
  it('is a poster with the file size and downloads nothing until clicked', async () => {
    const log: string[] = []
    const a = viewer('a', small, log)
    await waitFor(a.actor, (s) => s.matches('poster'))
    expect(a.actor.getSnapshot().context).toMatchObject(small)
    expect(log).toEqual([])
    a.actor.send({ type: 'viewer.open' })
    expect(view(a.actor)).toBe('{"live":"loading"}')
    expect(log).toEqual(['a mount'])
    a.report({ type: 'viewer.loaded' })
    expect(view(a.actor)).toBe('{"live":"ready"}')
    a.stop()
  })

  it('keeps one model open: opening another disposes the first and turns it back into a poster', async () => {
    const log: string[] = []
    const a = viewer('a', small, log)
    const b = viewer('b', small, log)
    await waitFor(b.actor, (s) => s.matches('poster'))
    a.actor.send({ type: 'viewer.open' })
    a.report({ type: 'viewer.loaded' })
    b.actor.send({ type: 'viewer.open' })
    expect(view(a.actor)).toBe('"poster"')
    expect(view(b.actor)).toBe('{"live":"loading"}')
    expect(log).toEqual(['a mount', 'a dispose', 'b mount'])
    // And back again.
    a.actor.send({ type: 'viewer.open' })
    expect(view(b.actor)).toBe('"poster"')
    expect(log.slice(3)).toEqual(['b dispose', 'a mount'])
    a.stop()
    b.stop()
  })

  it('closes and disposes when scrolled far away', () => {
    const log: string[] = []
    const a = viewer('a', small, log)
    a.actor.send({ type: 'viewer.open' })
    a.actor.send({ type: 'viewer.close' })
    expect(view(a.actor)).toBe('"poster"')
    expect(log).toEqual(['a mount', 'a dispose'])
    a.stop()
  })

  it('never opens a file over the limit', async () => {
    const log: string[] = []
    const a = viewer('a', { size: MODEL_MAX_BYTES + 1, name: 'huge.glb' }, log)
    await waitFor(a.actor, (s) => s.matches('tooLarge'))
    expect(a.actor.getSnapshot().can({ type: 'viewer.open' })).toBe(false)
    expect(log).toEqual([])
    a.stop()
  })

  it('stops a download that turns out too large, and retries a failed load on click', () => {
    const log: string[] = []
    const a = viewer('a', { size: null, name: null }, log)
    a.actor.send({ type: 'viewer.open' })
    a.report({ type: 'viewer.failed', message: "Couldn't load model" })
    expect(view(a.actor)).toBe('"failed"')
    expect(a.actor.getSnapshot().context.error).toBe("Couldn't load model")
    a.actor.send({ type: 'viewer.open' })
    a.report({ type: 'viewer.tooLarge', size: MODEL_MAX_BYTES + 5 })
    expect(view(a.actor)).toBe('"tooLarge"')
    expect(a.actor.getSnapshot().context.size).toBe(MODEL_MAX_BYTES + 5)
    expect(log).toEqual(['a mount', 'a dispose', 'a mount', 'a dispose'])
    a.stop()
  })
})
