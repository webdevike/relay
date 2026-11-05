import { describe, expect, it } from 'vitest'
import { placeOf } from '@evaos/shell-core'
import { addressOfPlace, formatAddress, parseAddress, type TabAddress } from './tab-address'

describe('relay:// addresses', () => {
  const cases: [TabAddress, string][] = [
    [{ kind: 'chat', file: '/s/a b.jsonl' }, 'relay://open/chat?chat=%2Fs%2Fa%20b.jsonl'],
    [
      { kind: 'chat', file: '/s/a.jsonl', message: 'm7' },
      'relay://open/chat?chat=%2Fs%2Fa.jsonl&message=m7',
    ],
    [{ kind: 'assistant', id: 'nova' }, 'relay://assistant/nova'],
    [
      { kind: 'web', url: 'https://example.com/a?b=1&c=2', ws: 'page:agent:nova' },
      'relay://open/web?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2&ws=page%3Aagent%3Anova',
    ],
    [
      { kind: 'file', path: '/Users/ike/Eva/x.ts', line: 40, ws: 'chat:/s/a.jsonl' },
      'relay://open/files?path=%2FUsers%2Fike%2FEva%2Fx.ts&line=40&ws=chat%3A%2Fs%2Fa.jsonl',
    ],
    [{ kind: 'canvas', board: 'mind-map' }, 'relay://open/canvas?canvas=mind-map'],
    [
      { kind: 'canvas', board: 'mind-map', node: 'n1' },
      'relay://open/canvas?canvas=mind-map&node=n1',
    ],
    [{ kind: 'studio', job: 'j1' }, 'relay://open/studio?job=j1'],
    [{ kind: 'review', item: 'pr:o/r#12' }, 'relay://open/reviews?item=pr%3Ao%2Fr%2312'],
    [
      { kind: 'page', link: { kind: 'open', page: 'settings', sub: 'links' } },
      'relay://open/settings/links',
    ],
    [{ kind: 'page', link: { kind: 'open', page: 'jobs' } }, 'relay://open/jobs'],
  ]
  it.each(cases)('%o', (address, url) => {
    expect(formatAddress(address)).toBe(url)
    expect(parseAddress(url)).toEqual(address)
  })

  it('keeps old forms working', () => {
    expect(parseAddress('relay://open/setting')).toEqual({
      kind: 'page',
      link: { kind: 'open', page: 'settings' },
    })
    expect(
      parseAddress('relay://open/reviews?item=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1'),
    ).toEqual({ kind: 'review', item: 'https://github.com/o/r/pull/1' })
    expect(parseAddress('relay://open/workspace/ecard')).toEqual({
      kind: 'page',
      link: { kind: 'open', page: 'workspace', sub: 'ecard' },
    })
  })

  it('rejects what is not an address', () => {
    expect(parseAddress('https://example.com')).toBeNull()
    expect(parseAddress('relay://open/web?url=file%3A%2F%2F%2Fetc')).toBeNull()
    expect(parseAddress('relay://open/files')).toBeNull()
    expect(parseAddress('relay://open/jobs?bogus=1')).toBeNull()
  })

  it('names places', () => {
    expect(addressOfPlace(placeOf('chat', { chat: '/s/a.jsonl' }))).toEqual({
      kind: 'chat',
      file: '/s/a.jsonl',
    })
    expect(addressOfPlace(placeOf('chat', { chat: 'draft' }))).toBeNull()
    expect(addressOfPlace(placeOf('agent:nova'))).toEqual({ kind: 'assistant', id: 'nova' })
    expect(addressOfPlace(placeOf('review:linear:ENG-1'))).toEqual({
      kind: 'review',
      item: 'linear:ENG-1',
    })
    expect(
      formatAddress(addressOfPlace(placeOf('settings', { settingsSection: 'Connections' }))!),
    ).toBe('relay://open/settings/connections')
    expect(formatAddress(addressOfPlace(placeOf('board:ops'))!)).toBe('relay://open/board/ops')
  })
})
