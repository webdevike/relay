import { describe, expect, it } from 'vitest'
import type { ReviewPrHit } from '@evaos/contract'
import { ticketPrs } from './ticket-prs'

const hit = (over: Partial<ReviewPrHit>): ReviewPrHit => ({
  repo: 'eCardSystems/app',
  number: 1,
  title: 'chore: something',
  url: 'https://github.com/eCardSystems/app/pull/1',
  state: 'OPEN',
  draft: false,
  head: 'chore/something',
  ...over,
})

describe('ticketPrs', () => {
  it('keeps hits naming the key in branch or title, drops body-only mentions and longer keys', () => {
    const prs = ticketPrs({
      key: 'ENG-6832',
      links: [],
      cardPr: null,
      hits: [
        hit({ number: 254, head: 'fix/ENG-6832-platform-assets', title: 'fix: panel' }),
        hit({ number: 7, title: 'fix: ref ENG-6832 blank tags', head: 'fix/tags' }),
        hit({ number: 172, title: 'fix: ref ENG-6648 follow-ups', head: 'fix/ENG-6648-x' }),
        hit({ number: 9, title: 'feat: ENG-68321 other ticket', head: 'feat/eng-68321' }),
      ],
    })
    expect(prs.map((p) => [p.number, p.via])).toEqual([
      [254, 'branch'],
      [7, 'title'],
    ])
  })

  it('links a Linear attachment even when no search finds it, with the live state when one does', () => {
    const prs = ticketPrs({
      key: 'ENG-6832',
      links: [
        {
          title: 'Attached PR',
          url: 'https://github.com/eCardSystems/api/pull/173',
          kind: 'github',
        },
        { title: 'Design doc', url: 'https://www.figma.com/file/x', kind: 'link' },
        { title: 'Other PR', url: 'https://github.com/eCardSystems/web/pull/5', kind: 'github' },
      ],
      cardPr: null,
      hits: [
        hit({
          repo: 'eCardSystems/api',
          number: 173,
          url: 'https://github.com/eCardSystems/api/pull/173',
          title: 'fix: versions paging',
          state: 'MERGED',
          head: 'unrelated-branch',
        }),
      ],
    })
    expect(prs).toEqual([
      {
        repo: 'eCardSystems/web',
        number: 5,
        url: 'https://github.com/eCardSystems/web/pull/5',
        title: 'Other PR',
        state: null,
        via: 'linear',
      },
      {
        repo: 'eCardSystems/api',
        number: 173,
        url: 'https://github.com/eCardSystems/api/pull/173',
        title: 'fix: versions paging',
        state: 'merged',
        via: 'linear',
      },
    ])
  })

  it('lists a PR once across sources, the first source deciding how it was linked', () => {
    const prs = ticketPrs({
      key: 'ENG-1',
      links: [],
      cardPr: {
        repo: 'eCardSystems/App',
        number: 3,
        url: 'https://github.com/eCardSystems/App/pull/3',
        state: 'draft',
        decision: null,
        checks: null,
      },
      hits: [hit({ number: 3, head: 'feat/ENG-1-x', state: 'OPEN', draft: false })],
    })
    expect(prs).toHaveLength(1)
    expect(prs[0]).toMatchObject({ via: 'agent', state: 'open', title: 'chore: something' })
  })
})
