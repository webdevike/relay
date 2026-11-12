import { describe, expect, it, vi } from 'vitest'
import { createActor, fromPromise, waitFor } from 'xstate'
import type { DesignItem } from '@evaos/contract'
import { designModeMachine, type DesignDraft } from './design-mode.machine'

const item = (selector: string, over: Partial<DesignItem> = {}): DesignItem => ({
  kind: 'element',
  selector,
  label: selector,
  missing: false,
  text: '',
  html: `<div>${selector}</div>`,
  box: { x: 0, y: 0, width: 10, height: 10 },
  source: null,
  component: null,
  styles: { padding: '12px' },
  crop: { png: 'iVBOR', width: 10, height: 10 },
  ...over,
})

function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function start(
  opts: {
    setMode?: () => Promise<void>
    send?: (d: DesignDraft) => Promise<void>
    /** Leave previews unanswered (the test answers with style.previewed / style.rejected). */
    holdPreviews?: boolean
  } = {},
) {
  const calls = {
    setMode: [] as boolean[],
    sent: [] as DesignDraft[],
    preview: [] as string[],
    select: [] as string[][],
  }
  const machine = designModeMachine.provide({
    actors: {
      setMode: fromPromise<void, { tabId: string; on: boolean }>(async ({ input }) => {
        calls.setMode.push(input.on)
        await (opts.setMode?.() ?? Promise.resolve())
      }),
      sendRequest: fromPromise<void, DesignDraft & { tabId: string }>(async ({ input }) => {
        calls.sent.push(input)
        await (opts.send?.(input) ?? Promise.resolve())
      }),
    },
    actions: {
      previewStyle: ({ self }, p) => {
        calls.preview.push(`${p.selector} ${p.property}: ${p.value}`)
        if (!opts.holdPreviews) self.send({ type: 'style.previewed' })
      },
      selectInPage: (_, p) => calls.select.push(p.selectors),
    },
  })
  const actor = createActor(machine, { input: { tabId: 't1' } }).start()
  return { actor, calls }
}

async function selected(items = [item('#a')], opts: Parameters<typeof start>[0] = {}) {
  const t = start(opts)
  t.actor.send({ type: 'design.toggle' })
  await waitFor(t.actor, (s) => s.matches({ on: 'picking' }))
  t.actor.send({ type: 'page.selection', items })
  return t
}

describe('designModeMachine', () => {
  it('turns on through main, picks, and turns off through main', async () => {
    const t = start()
    t.actor.send({ type: 'design.toggle' })
    expect(t.actor.getSnapshot().value).toBe('starting')
    await waitFor(t.actor, (s) => s.matches({ on: 'picking' }))
    t.actor.send({ type: 'page.selection', items: [item('#a')] })
    expect(t.actor.getSnapshot().matches({ on: { selected: 'editing' } })).toBe(true)
    t.actor.send({ type: 'design.exit' })
    await waitFor(t.actor, (s) => s.matches('off'))
    expect(t.calls.setMode).toEqual([true, false])
    expect(t.actor.getSnapshot().context.items).toEqual([])
  })

  it('a page that refuses the mode leaves it off with the reason', async () => {
    const t = start({
      setMode: () => Promise.reject(new Error('Design Mode could not reach this page')),
    })
    t.actor.send({ type: 'design.toggle' })
    const s = await waitFor(t.actor, (x) => x.matches('off') && x.context.error !== null)
    expect(s.context.error).toBe('Design Mode could not reach this page')
  })

  it('the page leaving (another site, closed) ends the mode without asking main again', async () => {
    const t = await selected()
    t.actor.send({ type: 'page.left' })
    expect(t.actor.getSnapshot().value).toBe('off')
    expect(t.calls.setMode).toEqual([true])
  })

  it('cannot send an empty request, nor a request with every element gone', async () => {
    const t = await selected()
    expect(t.actor.getSnapshot().can({ type: 'request.send' })).toBe(false)
    t.actor.send({ type: 'instruction.change', text: '   ' })
    expect(t.actor.getSnapshot().can({ type: 'request.send' })).toBe(false)
    t.actor.send({ type: 'instruction.change', text: 'quieter' })
    expect(t.actor.getSnapshot().can({ type: 'request.send' })).toBe(true)
    t.actor.send({ type: 'page.selection', items: [item('#a', { missing: true, crop: null })] })
    expect(t.actor.getSnapshot().can({ type: 'request.send' })).toBe(false)
  })

  it('cannot send before anything is selected', async () => {
    const t = start()
    t.actor.send({ type: 'design.toggle' })
    await waitFor(t.actor, (s) => s.matches({ on: 'picking' }))
    t.actor.send({ type: 'instruction.change', text: 'quieter' })
    expect(t.actor.getSnapshot().can({ type: 'request.send' })).toBe(false)
  })

  it('sends once, keeps the selection, and clears the request after it went', async () => {
    const gate = pending<void>()
    const t = start({ send: () => gate.promise })
    t.actor.send({ type: 'design.toggle' })
    await waitFor(t.actor, (s) => s.matches({ on: 'picking' }))
    t.actor.send({ type: 'page.selection', items: [item('#a')] })
    t.actor.send({ type: 'instruction.change', text: '8px tighter' })
    t.actor.send({ type: 'request.send' })
    t.actor.send({ type: 'request.send' })
    expect(t.actor.getSnapshot().matches({ on: 'sending' })).toBe(true)
    expect(t.calls.sent).toHaveLength(1)
    expect(t.calls.sent[0]!.instruction).toBe('8px tighter')
    gate.resolve()
    const s = await waitFor(t.actor, (x) => x.matches({ on: { selected: 'sent' } }))
    expect(s.context.items.map((i) => i.selector)).toEqual(['#a'])
    expect(s.context.instruction).toBe('')
    // A hot update after the agent's edit: the selection follows and the mode stays sent.
    t.actor.send({ type: 'page.selection', items: [item('#a', { styles: { padding: '8px' } })] })
    expect(t.actor.getSnapshot().matches({ on: { selected: 'sent' } })).toBe(true)
    expect(t.actor.getSnapshot().context.items[0]!.styles.padding).toBe('8px')
  })

  it('the composer sending the selection with a chat message clears the request and keeps the selection', async () => {
    const t = await selected([item('#a')])
    t.actor.send({ type: 'style.edit', selector: '#a', property: 'padding', value: '20px' })
    expect(t.actor.getSnapshot().context.edits).toHaveLength(1)
    t.actor.send({ type: 'request.consumed' })
    const s = t.actor.getSnapshot()
    expect(s.matches({ on: { selected: 'sent' } })).toBe(true)
    expect(s.context.edits).toEqual([])
    expect(s.context.items.map((i) => i.selector)).toEqual(['#a'])
    // A hot update of the same element stays handed off; picking another one is live again.
    t.actor.send({ type: 'page.selection', items: [item('#a')] })
    expect(t.actor.getSnapshot().matches({ on: { selected: 'sent' } })).toBe(true)
    t.actor.send({ type: 'page.selection', items: [item('#a'), item('#b')] })
    expect(t.actor.getSnapshot().matches({ on: { selected: 'editing' } })).toBe(true)
  })

  it('a failed send goes back to editing with the error and the request intact', async () => {
    const t = start({ send: () => Promise.reject(new Error('No chat in this workspace')) })
    t.actor.send({ type: 'design.toggle' })
    await waitFor(t.actor, (s) => s.matches({ on: 'picking' }))
    t.actor.send({ type: 'page.selection', items: [item('#a')] })
    t.actor.send({ type: 'instruction.change', text: 'quieter' })
    t.actor.send({ type: 'request.send' })
    const s = await waitFor(t.actor, (x) => x.context.error !== null)
    expect(s.matches({ on: { selected: 'editing' } })).toBe(true)
    expect(s.context.error).toBe('No chat in this workspace')
    expect(s.context.instruction).toBe('quieter')
  })

  it('style edits preview in the page, keep their first value, and vanish when undone', async () => {
    const t = await selected()
    t.actor.send({ type: 'style.edit', selector: '#a', property: 'padding', value: '10px' })
    t.actor.send({ type: 'page.selection', items: [item('#a', { styles: { padding: '10px' } })] })
    t.actor.send({ type: 'style.edit', selector: '#a', property: 'padding', value: '8px' })
    expect(t.calls.preview).toEqual(['#a padding: 10px', '#a padding: 8px'])
    expect(t.actor.getSnapshot().context.edits).toEqual([
      { selector: '#a', property: 'padding', from: '12px', to: '8px' },
    ])
    expect(t.actor.getSnapshot().can({ type: 'request.send' })).toBe(true)
    t.actor.send({ type: 'style.edit', selector: '#a', property: 'padding', value: '12px' })
    expect(t.actor.getSnapshot().context.edits).toEqual([])
  })

  it('drawing needs a crop, and the drawing replaces that crop in the request', async () => {
    const t = await selected([item('#a'), item('#b', { crop: null })])
    expect(t.actor.getSnapshot().can({ type: 'draw.open', selector: '#b' })).toBe(false)
    t.actor.send({ type: 'draw.open', selector: '#a' })
    expect(t.actor.getSnapshot().matches({ on: 'drawing' })).toBe(true)
    expect(t.actor.getSnapshot().can({ type: 'request.send' })).toBe(false)
    t.actor.send({ type: 'draw.done', png: 'DRAWN' })
    const s = t.actor.getSnapshot()
    expect(s.matches({ on: { selected: 'editing' } })).toBe(true)
    expect(s.context.drawings).toEqual({ '#a': 'DRAWN' })
    expect(s.can({ type: 'request.send' })).toBe(true)
  })

  it('removing an element asks main; an element the page dropped loses its edits and drawing', async () => {
    const t = await selected([item('#a'), item('#b')])
    t.actor.send({ type: 'style.edit', selector: '#b', property: 'padding', value: '2px' })
    t.actor.send({ type: 'draw.open', selector: '#b' })
    t.actor.send({ type: 'draw.done', png: 'X' })
    t.actor.send({ type: 'item.remove', selector: '#b' })
    expect(t.calls.select).toEqual([['#a']])
    t.actor.send({ type: 'page.selection', items: [item('#a')] })
    const c = t.actor.getSnapshot().context
    expect(c.edits).toEqual([])
    expect(c.drawings).toEqual({})
  })

  it('an empty selection from the page goes back to picking', async () => {
    const t = await selected()
    t.actor.send({ type: 'instruction.change', text: 'x' })
    t.actor.send({ type: 'page.selection', items: [] })
    const s = t.actor.getSnapshot()
    expect(s.matches({ on: 'picking' })).toBe(true)
    expect(s.context.instruction).toBe('')
  })

  it('Escape while drawing ends the mode (the drawing modal handles its own Escape first)', async () => {
    const t = await selected()
    t.actor.send({ type: 'draw.open', selector: '#a' })
    t.actor.send({ type: 'design.exit' })
    await waitFor(t.actor, (s) => s.matches('off'))
    expect(t.calls.setMode).toEqual([true, false])
  })

  it('ending the mode before main answers turns main off again', async () => {
    const gate = pending<void>()
    let n = 0
    const t = start({ setMode: () => (n++ === 0 ? gate.promise : Promise.resolve()) })
    t.actor.send({ type: 'design.toggle' })
    t.actor.send({ type: 'design.exit' })
    gate.resolve()
    await waitFor(t.actor, (s) => s.matches('off'))
    expect(t.calls.setMode).toEqual([true, false])
  })

  it('a click that beats main answering lands in selected once main answers', async () => {
    const gate = pending<void>()
    const t = start({ setMode: () => gate.promise })
    t.actor.send({ type: 'design.toggle' })
    t.actor.send({ type: 'page.selection', items: [item('#a')] })
    expect(t.actor.getSnapshot().value).toBe('starting')
    gate.resolve()
    const s = await waitFor(t.actor, (x) => x.matches('on'))
    expect(s.matches({ on: { selected: 'editing' } })).toBe(true)
    expect(s.context.items.map((i) => i.selector)).toEqual(['#a'])
  })

  it('drawing keeps the image it opened on, and stops when its element leaves the selection', async () => {
    const t = await selected([item('#a'), item('#b')])
    t.actor.send({ type: 'draw.open', selector: '#a' })
    t.actor.send({
      type: 'page.selection',
      items: [item('#a', { crop: { png: 'NEWER', width: 10, height: 10 } }), item('#b')],
    })
    expect(t.actor.getSnapshot().matches({ on: 'drawing' })).toBe(true)
    expect(t.actor.getSnapshot().context.drawingFrom).toBe('iVBOR')
    t.actor.send({ type: 'page.selection', items: [item('#b')] })
    const s = t.actor.getSnapshot()
    expect(s.matches({ on: { selected: 'editing' } })).toBe(true)
    expect(s.context.drawingOf).toBeNull()
    expect(s.context.drawingFrom).toBeNull()
    t.actor.send({ type: 'draw.done', png: 'LATE' })
    expect(t.actor.getSnapshot().context.drawings).toEqual({})
  })

  it('an edit of an element that went missing does not make a request on its own', async () => {
    const t = await selected([item('#a'), item('#b')])
    t.actor.send({ type: 'style.edit', selector: '#a', property: 'padding', value: '2px' })
    expect(t.actor.getSnapshot().can({ type: 'request.send' })).toBe(true)
    t.actor.send({ type: 'page.selection', items: [item('#a', { missing: true }), item('#b')] })
    expect(t.actor.getSnapshot().can({ type: 'request.send' })).toBe(false)
  })

  it('a value CSS does not take is refused with why, never previewed or sent', async () => {
    vi.stubGlobal('CSS', { supports: (_p: string, v: string) => v !== 'banana' })
    try {
      const t = await selected()
      t.actor.send({ type: 'style.edit', selector: '#a', property: 'padding', value: 'banana' })
      const s = t.actor.getSnapshot()
      expect(s.context.edits).toEqual([])
      expect(s.context.error).toBe('"banana" is not a padding value')
      expect(t.calls.preview).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a preview the page refused drops that edit and keeps the reason', async () => {
    const t = await selected()
    t.actor.send({ type: 'style.edit', selector: '#a', property: 'padding', value: '2px' })
    t.actor.send({
      type: 'style.rejected',
      selector: '#a',
      property: 'padding',
      value: '2px',
      message: 'That element is not in the page right now',
    })
    const s = t.actor.getSnapshot()
    expect(s.context.edits).toEqual([])
    expect(s.context.error).toBe('That element is not in the page right now')
  })

  it('a Send pressed before the page answered a preview waits, and leaves out a refused edit', async () => {
    const t = await selected([item('#a')], { holdPreviews: true })
    t.actor.send({ type: 'style.edit', selector: '#a', property: 'padding', value: '2px' })
    t.actor.send({ type: 'request.send' })
    expect(t.calls.sent).toEqual([])
    t.actor.send({
      type: 'style.rejected',
      selector: '#a',
      property: 'padding',
      value: '2px',
      message: 'That element is not in the page right now',
    })
    // Nothing left to say: the queued Send is dropped.
    expect(t.calls.sent).toEqual([])
    expect(t.actor.getSnapshot().context.sendQueued).toBe(false)

    t.actor.send({ type: 'instruction.change', text: 'quieter' })
    t.actor.send({ type: 'style.edit', selector: '#a', property: 'padding', value: '4px' })
    t.actor.send({ type: 'request.send' })
    expect(t.calls.sent).toEqual([])
    t.actor.send({ type: 'style.previewed' })
    await waitFor(t.actor, (s) => s.matches({ on: { selected: 'sent' } }))
    expect(t.calls.sent[0]!.edits).toEqual([
      { selector: '#a', property: 'padding', from: '12px', to: '4px' },
    ])
  })
})
