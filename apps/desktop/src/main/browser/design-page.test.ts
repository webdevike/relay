// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DESIGN_OVERLAY,
  FINGERPRINT,
  RESOLVE,
  RESTORE,
  SELECTOR_PATH,
  type Fingerprint,
  type OverlayAnswer,
  type OverlayCommand,
  type Restored,
} from './design-page'

// The page functions as the page gets them: their source alone, no module around it.
const page = <T>(source: string): T => new Function(`return (${source})`)() as T
const selectorPath = page<(element: Element) => string>(SELECTOR_PATH)
const resolve = page<(selector: string) => Element | null>(RESOLVE)
const fingerprintOf = page<(element: Element) => Fingerprint>(FINGERPRINT)
const restoreFn =
  page<
    (
      selector: string,
      print: Fingerprint | null,
      fingerprintOf: (element: Element) => Fingerprint,
    ) => Restored | null
  >(RESTORE)
const restore = (selector: string, print: Fingerprint | null) =>
  restoreFn(selector, print, fingerprintOf)

/** The demo shop's cards (work/relay-browser-demo): rebuilt from nothing on every render. */
const PLANTS = [
  'Monstera Deliciosa',
  'Snake Plant',
  'Fiddle Leaf Fig',
  'Self-watering Pot',
  'Grow Light Bar',
  'Pothos Trio',
]
function shop(names: string[]): void {
  document.body.innerHTML =
    '<header><input id="q" /></header><main><div class="grid" id="grid"></div></main>'
  const grid = document.getElementById('grid')!
  grid.innerHTML = ''
  for (const name of names) {
    const d = document.createElement('div')
    d.className = 'card'
    d.innerHTML = `<div class="img"></div><h3>${name}</h3><div class="price">$20</div><button class="ghost">Add to cart</button>`
    grid.appendChild(d)
  }
}
const cards = (): Element[] => Array.from(document.querySelectorAll('#grid > .card'))
const cardNamed = (name: string): Element =>
  cards().find((c) => c.querySelector('h3')!.textContent === name)!

/** `selector` names `element` and nothing else. */
function expectNames(selector: string, element: Element): void {
  const all = document.querySelectorAll(selector)
  expect(all).toHaveLength(1)
  expect(all[0]).toBe(element)
}

describe('selectorPath', () => {
  it('names each of six identical cards alone', () => {
    shop(Array(6).fill('Plant'))
    cards().forEach((card, i) => {
      const sel = selectorPath(card)
      expect(sel).toBe(`#grid > div.card:nth-of-type(${i + 1})`)
      expectNames(sel, card)
      // And what is inside each one.
      expectNames(selectorPath(card.querySelector('button')!), card.querySelector('button')!)
    })
  })

  it('names identical elements without any id, and items of nested lists', () => {
    document.body.innerHTML = `<main>${'<section><ul><li class="row"><span>x</span></li><li class="row"><span>x</span></li></ul></section>'.repeat(3)}</main>`
    const spans = Array.from(document.querySelectorAll('span'))
    expect(spans).toHaveLength(6)
    const paths = spans.map((span) => {
      const sel = selectorPath(span)
      expectNames(sel, span)
      return sel
    })
    expect(new Set(paths).size).toBe(6)
    expect(paths[3]).toBe(
      'body > main > section:nth-of-type(2) > ul > li.row:nth-of-type(2) > span',
    )
  })

  it('anchors on a unique test id or aria-label, never on a generated id or a shared label', () => {
    document.body.innerHTML = `
      <div id=":r1:"><button aria-label="Add Grow Light Bar">Add</button><button aria-label="Add">Add</button></div>
      <div><button aria-label="Add">Add</button><p data-testid="note">n</p></div>`
    const [own, shared] = Array.from(document.querySelectorAll('button'))
    expect(selectorPath(own!)).toBe('button[aria-label="Add Grow Light Bar"]')
    expect(selectorPath(shared!)).toBe('body > div:nth-of-type(1) > button:nth-of-type(2)')
    expect(selectorPath(document.querySelector('p')!)).toBe('[data-testid="note"]')
  })

  it('falls back to the nth-child chain from body when the pretty path names more', () => {
    // 70 nested divs: the pretty path stops at 64 steps, which the deeper ones match too.
    document.body.innerHTML = '<div>'.repeat(70) + '</div>'.repeat(70)
    const deepest = Array.from(document.querySelectorAll('div')).at(-1)!
    const sel = selectorPath(deepest)
    expect(sel.startsWith('body > div:nth-child(1) > ')).toBe(true)
    expectNames(sel, deepest)
    expect(sel.length).toBeLessThanOrEqual(2048)
  })

  it('names an element inside a shadow root alone in its root', () => {
    document.body.innerHTML = '<x-card id="xc"></x-card><x-card></x-card>'
    const root = document.getElementById('xc')!.attachShadow({ mode: 'open' })
    root.innerHTML = '<div class="inner"><span></span><span></span></div>'
    const span = root.querySelectorAll('span')[1]!
    const sel = selectorPath(span)
    expect(sel).toBe('#xc >>> div.inner > span:nth-of-type(2)')
    expect(root.querySelectorAll(sel.split(' >>> ')[1]!)).toHaveLength(1)
    expect(resolve(sel)).toBe(span)
  })
})

describe('resolve', () => {
  it('finds only an element a path names alone, never the first of several', () => {
    shop(PLANTS)
    expect(resolve('#grid > div.card')).toBeNull()
    expect(resolve('#grid > div.card:nth-of-type(5)')).toBe(cardNamed('Grow Light Bar'))
    expect(resolve('#grid > ::bad')).toBeNull()
  })
})

describe('restore', () => {
  it('the reported bug: a card picked while a search showed it alone comes back as itself', () => {
    // The tour searched "light": the grid showed only the Grow Light Bar card when Isaac picked it.
    shop(['Grow Light Bar'])
    const picked = cardNamed('Grow Light Bar')
    const selector = selectorPath(picked)
    // Unique when it was made, with no position: there was nothing to tell apart.
    expect(selector).toBe('#grid > div.card')
    const print = fingerprintOf(picked)
    // The reload renders every card again; the path now names all six, the first one first.
    shop(PLANTS)
    expect(document.querySelector(selector)).toBe(cardNamed('Monstera Deliciosa'))
    const found = restore(selector, print)!
    expect(found).toMatchObject({ exact: false, strong: true })
    expect(found.element).toBe(cardNamed('Grow Light Bar'))
    // And it is named again by a path that holds now.
    const next = selectorPath(found.element)
    expect(next).toBe('#grid > div.card:nth-of-type(5)')
    expectNames(next, found.element)
  })

  it('keeps the 5th of six identical cards through a re-render', () => {
    shop(Array(6).fill('Plant'))
    const selector = selectorPath(cards()[4]!)
    const print = fingerprintOf(cards()[4]!)
    shop(Array(6).fill('Plant'))
    expect(restore(selector, print)).toMatchObject({
      element: cards()[4],
      exact: true,
      strong: true,
    })
  })

  it('follows its card when one is inserted before it', () => {
    shop(PLANTS)
    const selector = selectorPath(cardNamed('Grow Light Bar'))
    const print = fingerprintOf(cardNamed('Grow Light Bar'))
    shop(['Bamboo Palm', ...PLANTS])
    const found = restore(selector, print)!
    expect(found).toMatchObject({ exact: false, strong: true })
    expect(found.element).toBe(cardNamed('Grow Light Bar'))
    expect(cards().indexOf(found.element)).toBe(5)
  })

  it('a child alike in every card is told apart by its card', () => {
    shop(['Grow Light Bar'])
    const img = cardNamed('Grow Light Bar').querySelector('.img')!
    const selector = selectorPath(img)
    const print = fingerprintOf(img)
    shop(PLANTS)
    expect(restore(selector, print)?.element).toBe(
      cardNamed('Grow Light Bar').querySelector('.img'),
    )
    // A card inserted before it: its path now names the image of the card before it.
    const grow = cardNamed('Grow Light Bar').querySelector('.img')!
    const growPath = selectorPath(grow)
    const growPrint = fingerprintOf(grow)
    shop(['Bamboo Palm', ...PLANTS])
    expect(document.querySelector(growPath)!.parentElement).toBe(cardNamed('Self-watering Pot'))
    expect(restore(growPath, growPrint)).toMatchObject({
      element: cardNamed('Grow Light Bar').querySelector('.img'),
      exact: false,
      strong: true,
    })
  })

  it('allows for its text edited: a little is a strong match, past recognizing a weak one', () => {
    shop(PLANTS)
    const selector = selectorPath(cardNamed('Grow Light Bar'))
    const print = fingerprintOf(cardNamed('Grow Light Bar'))
    shop(PLANTS.map((n) => (n === 'Grow Light Bar' ? 'Grow Lamp Bar' : n)))
    expect(restore(selector, print)).toMatchObject({
      element: cardNamed('Grow Lamp Bar'),
      exact: true,
      strong: true,
    })
    shop(PLANTS.map((n) => (n === 'Grow Light Bar' ? 'Sunbeam' : n)))
    expect(restore(selector, print)).toMatchObject({
      element: cardNamed('Sunbeam'),
      exact: true,
      strong: false,
    })
  })

  it('several equally good or none recognized: null, never the first', () => {
    document.body.innerHTML = '<ul><li>A</li></ul>'
    const selector = selectorPath(document.querySelector('li')!)
    const print = fingerprintOf(document.querySelector('li')!)
    document.body.innerHTML = '<ul><li>A</li></ul><ul><li>A</li></ul>'
    expect(restore(selector, print)).toBeNull()
    // The card's place holds another card of another list (its text and its grid's differ): not it.
    shop(['Grow Light Bar'])
    const card = fingerprintOf(cardNamed('Grow Light Bar'))
    shop(['Monstera Deliciosa'])
    expect(restore('#grid > div.card', card)).toBeNull()
    // Without a print only a path that names one element finds it.
    shop(PLANTS)
    expect(restore('#grid > div.card', null)).toBeNull()
    expect(restore('#grid > div.card:nth-of-type(2)', null)?.element).toBe(cardNamed('Snake Plant'))
  })
})

describe('the overlay keeps the selection through a reload and a re-render', () => {
  const overlay =
    page<
      (
        cmd: OverlayCommand,
        selectorPath: unknown,
        restore: unknown,
        fingerprintOf: unknown,
        pickerHost: string,
      ) => OverlayAnswer
    >(DESIGN_OVERLAY)
  const run = (cmd: OverlayCommand): OverlayAnswer =>
    overlay(cmd, selectorPath, restoreFn, fingerprintOf, 'relay-note-picker')
  let under: Element | null = null

  beforeEach(() => {
    CSSStyleSheet.prototype.replaceSync ??= () => undefined
    // jsdom has no layout: the test says what is under the pointer.
    document.elementsFromPoint = () => (under ? [under, document.body] : [document.body])
  })
  afterEach(() => {
    run({ op: 'destroy' })
  })

  it('picks the only card a search shows, then finds the same card after the reload', async () => {
    shop(['Grow Light Bar'])
    run({ op: 'init', color: '#4c6ef5' })
    under = cardNamed('Grow Light Bar')
    const picked = run({ op: 'pick', x: 1, y: 1, add: false, max: 8 })
    expect(picked.selectors).toEqual(['#grid > div.card'])
    expect(picked.found).toEqual([true])
    expect(picked.prints[0]!.text).toContain('grow light bar')

    // The reload: the old document's overlay is gone; main hands the new one what it kept.
    run({ op: 'destroy' })
    shop(PLANTS)
    run({ op: 'init', color: '#4c6ef5' })
    const items = picked.selectors.map((selector, i) => ({ selector, print: picked.prints[i]! }))
    const back = run({ op: 'select', items })
    expect(back.found).toEqual([true])
    expectNames(back.selectors[0]!, cardNamed('Grow Light Bar'))

    // The page renders its cards again in place: the overlay follows on its next frames.
    shop(PLANTS)
    await vi.waitFor(() => {
      const after = run({ op: 'status' })
      expect(after.found).toEqual([true])
      expectNames(after.selectors[0]!, cardNamed('Grow Light Bar'))
    })

    // A path alone that names several finds nothing, not the first.
    const loose = run({ op: 'select', items: [{ selector: '#grid > div.card', print: null }] })
    expect(loose.found).toEqual([false])
  })
})
