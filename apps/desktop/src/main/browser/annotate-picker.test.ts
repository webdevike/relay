// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { describeElement } from './annotate-picker'

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

  it('runs as page code: its source stands alone', () => {
    const fn = new Function(`return (${String(describeElement)})`)() as typeof describeElement
    expect(fn($('#docs')).selector).toBe('#docs')
  })
})
