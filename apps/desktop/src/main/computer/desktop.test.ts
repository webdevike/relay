import { describe, expect, it } from 'vitest'
import { Desktop } from './desktop'
import type { Driver } from './driver'

const win = (id: number, title: string) => ({
  window_id: id,
  pid: 7,
  app_name: 'Linear',
  title,
  is_on_screen: true,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
})

function fakeDriver(titles: () => string): Driver {
  return {
    backend: 'direct',
    close() {},
    async call(name) {
      if (name !== 'list_windows') throw new Error(`unexpected ${name}`)
      return { result: { structuredContent: { windows: [win(1, titles())] } } }
    },
  }
}

describe('Desktop.openUrl', () => {
  it('opens only web and app links, never files or scripts', async () => {
    const opened: string[] = []
    const d = new Desktop(fakeDriver(() => 'Inbox'), async () => {}, async (u) => void opened.push(u))
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ssh://host', '/Applications/Calculator.app', 'constructor:x']) {
      await expect(d.openUrl(bad)).rejects.toThrow(/links open/)
    }
    expect(opened).toEqual([])
  })

  it('answers the window the link retitled', async () => {
    let title = 'Inbox'
    const d = new Desktop(fakeDriver(() => title), async () => {}, async () => {
      title = 'ENG-6810 Card art'
    })
    const r = await d.openUrl('linear://ecard-systems/issue/ENG-6810')
    expect(r.landed?.title).toBe('ENG-6810 Card art')
  })
})
