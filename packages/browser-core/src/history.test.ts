import { describe, expect, it } from 'vitest'
import { addVisit, makeVisit, suggest, visitKey, type Visit } from './history'

function history(): Visit[] {
  const h: Visit[] = []
  for (const [url, title, visits] of [
    ['https://x.com/home', 'Home / X', 28],
    ['https://github.com/webdevike/eva', 'eva', 3],
    ['https://www.github.com/', 'GitHub', 10],
    ['https://news.ycombinator.com/', 'Hacker News', 40],
    ['https://linear.app/ecard/issue/ENG-2075', 'ENG-2075 Toolbar CSV', 6],
    ['http://localhost:4317/', 'eCard • Table exploration', 94],
  ] as const) {
    addVisit(h, makeVisit(url, title, visits))
  }
  return h
}
const urls = (v: Visit[]) => v.map((x) => x.url)

describe('history', () => {
  it('visitKey strips scheme, www, trailing slash and case', () => {
    expect(visitKey('https://www.Example.com/a/')).toBe('example.com/a')
  })

  it('typed address prefixes beat more visited pages that only contain the text', () => {
    const h = history()
    expect(urls(suggest(h, 'git', 5))).toEqual([
      'https://www.github.com/',
      'https://github.com/webdevike/eva',
    ])
    expect(suggest(h, 'https://www.git', 1)[0]!.url).toBe('https://www.github.com/')
    expect(urls(suggest(h, 'ycomb', 5))).toEqual(['https://news.ycombinator.com/'])
  })

  it('every word must match the url or the title', () => {
    const h = history()
    expect(urls(suggest(h, 'toolbar eng', 5))).toEqual(['https://linear.app/ecard/issue/ENG-2075'])
    expect(urls(suggest(h, 'table ecard', 5))).toEqual(['http://localhost:4317/'])
    expect(suggest(h, 'toolbar github', 5)).toEqual([])
    expect(suggest(h, '   ', 5)).toEqual([])
  })

  it('ranks by visits then shorter key, limit defaults to 6', () => {
    const h: Visit[] = []
    for (let i = 0; i < 10; i++) addVisit(h, makeVisit(`https://a${i}.test/`, '', i))
    const out = suggest(h, 'test')
    expect(out).toHaveLength(6)
    expect(out[0]!.visits).toBe(9)
  })

  it('the same page folds into one entry', () => {
    const h = history()
    const before = h.length
    addVisit(h, makeVisit('http://github.com', '', 2))
    addVisit(h, makeVisit('https://x.com/home', 'X', 0))
    expect(h.length).toBe(before)
    const gh = h.find((v) => v.key === 'github.com')!
    expect([gh.visits, gh.title]).toEqual([12, 'GitHub'])
    expect(h.find((v) => v.key === 'x.com/home')!.title).toBe('X')
    addVisit(h, makeVisit('https://new.example/', 'New', 0))
    addVisit(h, makeVisit('https://new.example', '', 1))
    expect(h.length).toBe(before + 1)
    const n = h.find((v) => v.key === 'new.example')!
    expect([n.visits, n.title]).toEqual([1, 'New'])
  })
})
