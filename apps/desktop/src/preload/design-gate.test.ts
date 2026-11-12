// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { installDesignGate, type GateIpc } from './design-gate'
import { DESIGN_GATE_CHANNEL, DESIGN_INPUT_EVENT } from './guest-channel'

/**
 * A fresh window (an iframe's, so gates never share one) with the gate installed and a page that
 * records what its own capture listeners see. Main's answer to the start query waits for `answer`.
 */
function gatedPage() {
  const holder = document.createElement('iframe')
  document.body.append(holder)
  const win = holder.contentWindow as Window & typeof globalThis
  const doc = win.document
  doc.body.innerHTML = '<input type="checkbox">'
  let push: (on: boolean) => void = () => undefined
  const started = Promise.withResolvers<unknown>()
  const ipc: GateIpc = {
    on: (channel, listener) => {
      if (channel === DESIGN_GATE_CHANNEL) push = (on) => listener({}, on)
    },
    invoke: () => started.promise,
  }
  installDesignGate(win, ipc)
  const seen: string[] = []
  const forwarded: unknown[] = []
  for (const type of ['mousedown', 'click']) doc.addEventListener(type, () => seen.push(type), true)
  doc.addEventListener(DESIGN_INPUT_EVENT, (e) =>
    forwarded.push(JSON.parse(String((e as CustomEvent).detail))),
  )
  const box = doc.querySelector('input')!
  return {
    win,
    doc,
    box,
    seen,
    forwarded,
    push: (on: boolean) => push(on),
    // The gate's own handler on the answer was attached first, so it has run when this resolves.
    answer: async (on: boolean) => {
      started.resolve(on)
      await started.promise
    },
    press: () =>
      box.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, clientX: 3, clientY: 4 })),
  }
}

describe('design gate', () => {
  it('holds the pointer from the page and forwards presses once main says the page is gated', async () => {
    const p = gatedPage()
    p.press()
    expect(p.seen).toEqual(['mousedown'])
    await p.answer(true)
    p.press()
    expect(p.seen).toEqual(['mousedown'])
    expect(p.forwarded).toEqual([{ type: 'mousedown', x: 3, y: 4, button: 0, shift: false }])
  })

  it('keeps a gate message over a later answer to the start query', async () => {
    const ended = gatedPage()
    ended.push(true)
    ended.push(false)
    await ended.answer(true)
    ended.press()
    expect(ended.seen).toEqual(['mousedown'])

    const started = gatedPage()
    started.push(true)
    await started.answer(false)
    started.press()
    expect(started.seen).toEqual([])
  })

  it('cancels activation while gated and lets it through once off', () => {
    const p = gatedPage()
    p.push(true)
    p.box.click()
    expect(p.box.checked).toBe(false)
    expect(p.seen).toEqual([])
    p.push(false)
    p.box.click()
    expect(p.box.checked).toBe(true)
    expect(p.seen).toEqual(['click'])
  })
})
