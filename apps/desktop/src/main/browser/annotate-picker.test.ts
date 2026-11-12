// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeElement, PICKER_SCRIPT, type PickOp, type PickResult } from './annotate-picker'
import { DESIGN_INPUT_EVENT } from '../../preload/guest-channel'

const $ = (sel: string): Element => document.querySelector(sel)!

describe('describeElement', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <h2>Plans</h2>
        <section>
          <div class="card"><p>One</p><button>Buy   now</button></div>
          <div class="card"><p>Two</p><button aria-label="Buy the Pro plan">Buy</button></div>
        </section>
        <a id="docs" href="/docs">Read the docs</a>
        <a data-testid="help" href="/help">Help</a>
        <label for="email">Email</label><input id="email" type="email" value="me@x.com" />
        <input id="pw" type="password" placeholder="Password" value="secret" />
        <span id="who">Card holder</span><input aria-labelledby="who" />
        <div id="9lives">odd id</div>
        <div role="tab" title="Settings tab">Settings</div>
      </main>`
  })

  it('names a button by its text and finds it by position', () => {
    const d = describeElement($('section > div:nth-of-type(1) > button'))
    expect(d).toEqual({
      tag: 'button',
      role: 'button',
      text: 'Buy now',
      selector: 'body > main > section > div:nth-of-type(1) > button',
    })
    expect(document.querySelectorAll(d.selector!)).toHaveLength(1)
  })

  it('prefers aria-label for the label', () => {
    expect(describeElement($('section > div:nth-of-type(2) > button'))).toMatchObject({
      label: 'Buy the Pro plan',
      text: 'Buy',
    })
  })

  it('anchors the selector on a unique id or test id', () => {
    expect(describeElement($('#docs'))).toEqual({
      tag: 'a',
      role: 'link',
      text: 'Read the docs',
      selector: '#docs',
    })
    expect(describeElement($('[data-testid=help]')).selector).toBe('[data-testid="help"]')
    const odd = describeElement($('[id="9lives"]'))
    expect(odd.selector).toBe('[id="9lives"]')
    expect(document.querySelector(odd.selector!)?.textContent).toBe('odd id')
  })

  it('labels fields by their label and never reads their value', () => {
    expect(describeElement($('#email'))).toEqual({
      tag: 'input',
      role: 'textbox',
      label: 'Email',
      selector: '#email',
    })
    const pw = describeElement($('#pw'))
    expect(pw).toMatchObject({ tag: 'input', label: 'Password' })
    expect(JSON.stringify(pw)).not.toContain('secret')
    expect(describeElement($('[aria-labelledby=who]')).label).toBe('Card holder')
  })

  it('keeps an explicit role and falls back to the title', () => {
    expect(describeElement($('[role=tab]'))).toMatchObject({
      tag: 'div',
      role: 'tab',
      label: 'Settings tab',
      text: 'Settings',
    })
    expect(describeElement($('h2'))).toMatchObject({ role: 'heading', text: 'Plans' })
  })

  it('clips long text', () => {
    document.body.innerHTML = `<p>${'word '.repeat(200)}</p>`
    const d = describeElement($('p'))
    expect(d.text!.length).toBe(400)
    expect(d.text!.endsWith('…')).toBe(true)
  })

  it('names each of six identical cards alone, and items of nested lists', () => {
    document.body.innerHTML = `<main><div id="grid">${'<div class="card"><h3>Plant</h3><button>Add</button></div>'.repeat(6)}</div>${'<ul><li><span>x</span></li><li><span>x</span></li></ul>'.repeat(2)}</main>`
    const picks = [...document.querySelectorAll('.card'), ...document.querySelectorAll('span')]
    for (const el of picks) {
      const sel = describeElement(el).selector!
      expect(document.querySelectorAll(sel)).toHaveLength(1)
      expect(document.querySelector(sel)).toBe(el)
    }
    expect(describeElement(document.querySelectorAll('.card')[4]!).selector).toBe(
      '#grid > div:nth-of-type(5)',
    )
  })

  it('never anchors on an id the page repeats; falls back to the nth-child chain when its path names more', () => {
    document.body.innerHTML =
      '<section id="dup"><p>a</p></section><section id="dup"><p>a</p></section><span data-testid="t">t</span><svg><clipPath><rect></rect></clipPath><clipPath><rect></rect></clipPath></svg>'
    const second = document.querySelectorAll('p')[1]!
    const sel = describeElement(second).selector!
    expect(sel).toBe('body > section:nth-of-type(2) > p')
    expect(document.querySelector(sel)).toBe(second)
    expect(describeElement($('span')).selector).toBe('[data-testid="t"]')
    // An SVG element's camelCase name is kept as written, so its path finds it.
    const rect = document.querySelectorAll('rect')[1]!
    const rectSel = describeElement(rect).selector!
    expect(document.querySelectorAll(rectSel)).toHaveLength(1)
    expect(document.querySelector(rectSel)).toBe(rect)
    // In a shadow root `p > span` names the top one and the one deeper in: positions tell them apart.
    const root = $('span').attachShadow({ mode: 'open' })
    root.innerHTML = '<p><span></span></p><div><i></i><p><span></span></p></div>'
    const top = root.querySelector('span')!
    const topSel = describeElement(top).selector!
    expect(topSel).toBe('p:nth-child(1) > span:nth-child(1)')
    expect(root.querySelectorAll(topSel)).toHaveLength(1)
    expect(root.querySelector(topSel)).toBe(top)
  })

  it('runs as page code: its source stands alone', () => {
    const fn = new Function(`return (${String(describeElement)})`)() as typeof describeElement
    expect(fn($('#docs')).selector).toBe('#docs')
  })
})

describe('the picker in Design Mode', () => {
  type Pick = (op: PickOp, describe: typeof describeElement) => PickResult | Promise<PickResult>
  const pick = new Function(`return (${PICKER_SCRIPT})`)() as Pick
  const seen: string[] = []
  const types = ['mousedown', 'mouseup', 'click', 'mousemove', 'mouseover', 'pointermove']
  const record = (e: Event): void => {
    seen.push(e.type)
  }

  beforeEach(() => {
    document.body.innerHTML = '<button id="buy">Buy</button>'
    // jsdom has no layout: the button is under every point.
    document.elementsFromPoint = () => [
      document.getElementById('relay-note-picker')!,
      $('#buy'),
      document.body,
    ]
    CSSStyleSheet.prototype.replaceSync ??= () => undefined
    // The page's own listeners, at the document in both phases (outside-click handlers).
    for (const t of types) {
      document.addEventListener(t, record, true)
      document.addEventListener(t, record)
    }
    seen.length = 0
  })
  afterEach(async () => {
    for (const t of types) {
      document.removeEventListener(t, record, true)
      document.removeEventListener(t, record)
      window.removeEventListener(t, record, true)
    }
    await pick({ op: 'clear' }, describeElement)
  })

  const host = (): Element => document.getElementById('relay-note-picker')!
  const at = { clientX: 5, clientY: 5, bubbles: true, cancelable: true }
  const press = (): void => {
    for (const t of ['mousemove', 'mouseover', 'mousedown', 'mouseup', 'click'])
      host().dispatchEvent(new MouseEvent(t, at))
    host().dispatchEvent(new Event('pointermove', { bubbles: true }))
  }

  it('keeps every pointer event from the page, before and after it answers', async () => {
    const answer = pick({ op: 'pick', color: '#f00', mode: 'design' }, describeElement)
    // A page listener on the window, added once the picker is open.
    for (const t of types) window.addEventListener(t, record, true)
    press()
    expect(await answer).toMatchObject({ cancelled: false, element: { selector: '#buy' } })
    // Between two picks the host stays and still takes the pointer.
    press()
    expect(seen).toEqual([])
  })

  it("picks from the guest preload gate's input: a Shift-drag and a click", async () => {
    const input = DESIGN_INPUT_EVENT
    const send = (type: string, x: number, y: number, shift = false): void => {
      const detail = JSON.stringify({ type, x, y, button: 0, shift })
      document.dispatchEvent(new CustomEvent(input, { detail }))
    }
    const op: PickOp = { op: 'pick', color: '#f00', mode: 'design', input }
    const drag = pick(op, describeElement)
    send('mousedown', 10, 10, true)
    send('mousemove', 60, 40, true)
    send('mouseup', 60, 40, true)
    expect(await drag).toEqual({
      cancelled: false,
      box: { x: 10, y: 10, w: 50, h: 30 },
      viewport: { width: innerWidth, height: innerHeight },
      shift: true,
      at: { x: 60, y: 40 },
    })
    const click = pick(op, describeElement)
    // Not JSON, or not a pointer: ignored.
    document.dispatchEvent(new CustomEvent(input, { detail: '{' }))
    document.dispatchEvent(new CustomEvent(input, { detail: '{"type":"mousedown"}' }))
    send('mousedown', 5, 5)
    send('mouseup', 5, 5)
    expect(await click).toMatchObject({ element: { selector: '#buy' }, shift: false })
  })

  it("never replaces a note's picker, and a note's pick replaces it", async () => {
    const note = pick({ op: 'pick', color: '#f00', mode: 'note' }, describeElement)
    expect(await pick({ op: 'pick', color: '#00f', mode: 'design' }, describeElement)).toEqual({
      cancelled: true,
    })
    expect(document.querySelectorAll('#relay-note-picker')).toHaveLength(1)
    await pick({ op: 'clear' }, describeElement)
    expect(await note).toEqual({ cancelled: true })

    const design = pick({ op: 'pick', color: '#00f', mode: 'design' }, describeElement)
    void pick({ op: 'pick', color: '#f00', mode: 'note' }, describeElement)
    expect(await design).toEqual({ cancelled: true })
  })
})
