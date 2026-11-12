import { describe, expect, it } from 'vitest'
import { noteText } from './agent-presence'

describe('noteText', () => {
  it('carries what the agent needs to find a comment: thread, board, page, card, and a link back', () => {
    const lines = noteText({
      surface: 'canvas',
      text: '  Make this bigger ',
      slug: 'mind-map',
      board: 'Q4 roadmap',
      page: 'page-1',
      thread: 't-1',
      node: { id: 'note 3', title: 'Launch' },
      at: { x: 10, y: 20 },
      reply: false,
    }).split('\n')
    const head = lines[0]!
    for (const id of ['t-1', 'mind-map', 'page-1', 'note 3']) expect(head).toContain(id)
    // Isaac's words, trimmed, on their own line.
    expect(lines).toContain('Make this bigger')
    // The card id is encoded in the link, so a space or & can't break it.
    expect(lines).toContain('relay://open/canvas?canvas=mind-map&node=note%203')
  })

  it('carries the page, the marked element and the screenshot path of a page note', () => {
    const text = noteText({
      surface: 'browser',
      text: 'This button is off',
      url: 'https://example.com/a',
      title: 'Example',
      tabId: 't3',
      element: { tag: 'button', label: 'Buy now', selector: '#buy' },
      region: { x: 1, y: 2, w: 30, h: 40 },
      image: '/cfg/notes/n1.png',
    })
    for (const part of ['t3', '#buy', 'https://example.com/a', '/cfg/notes/n1.png']) {
      expect(text).toContain(part)
    }
    expect(text.split('\n')).toContain('This button is off')
  })
})
