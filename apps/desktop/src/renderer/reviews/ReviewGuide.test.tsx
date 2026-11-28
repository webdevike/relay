import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewGuide as Guide, ReviewPr } from '@evaos/contract'
import fixture from '@relay/protocol/fixtures/review-guide.json'

let answer: Guide | string = fixture.expected as Guide
const invoke = vi.fn(async (_ch: string, _input: unknown) =>
  typeof answer === 'string'
    ? { ok: false, error: { code: 'x', message: answer } }
    : { ok: true, value: answer },
)
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [string, unknown])),
  on: () => () => {},
}))
vi.mock('../navigation/open-link', () => ({ openLink: () => {} }))

import { ReviewGuide } from './ReviewGuide'

const PR = {
  repo: 'o/r',
  number: 7,
  title: 'Lock edits after 30 minutes',
  url: 'https://github.com/o/r/pull/7',
  author: { login: 'sam', avatarUrl: null },
  base: 'main',
  head: 'lock',
  headSha: 'head1',
  baseSha: 'base1',
  updatedAt: 1,
  files: fixture.input.files.map((f) => ({ ...f, change: 'MODIFIED' })),
  diff: fixture.input.diff,
} as unknown as ReviewPr

type Reload = () => Promise<boolean>
const view = (pr: ReviewPr, onViewInDiff = vi.fn(), onStale?: Reload) => (
  <MantineProvider>
    <ReviewGuide
      pr={pr}
      viewed={new Set()}
      onViewed={() => {}}
      onViewInDiff={onViewInDiff}
      onStale={onStale}
    />
  </MantineProvider>
)
const show = (onViewInDiff = vi.fn(), onStale?: Reload) => render(view(PR, onViewInDiff, onStale))

beforeEach(() => {
  localStorage.clear()
  invoke.mockClear()
  answer = fixture.expected as Guide
})

describe('ReviewGuide', () => {
  it('asks for the head it shows and renders a v2 walkthrough with only the cited hunks', async () => {
    const onViewInDiff = vi.fn()
    show(onViewInDiff)
    const sections = await screen.findAllByTestId('review-guide-section')
    expect(invoke).toHaveBeenCalledWith('reviews.guide', {
      repo: 'o/r',
      number: 7,
      headSha: 'head1',
      baseSha: 'base1',
    })
    // Concept sections only: the hunk-less "Other changed files" section is for old clients.
    expect(sections).toHaveLength(4)
    expect(screen.queryByText('Other changed files')).toBeNull()
    expect(screen.queryByTestId('review-guide-missing')).toBeNull()
    expect(screen.queryByTestId('review-guide-partial')).toBeNull()
    expect(screen.getByTestId('review-guide-overview').textContent).toContain('medium risk')
    expect(within(sections[0]!).getByText('Minutes, not milliseconds')).toBeTruthy()
    expect(within(sections[0]!).getAllByTestId('review-diff-annotation')).toHaveLength(2)
    expect(within(sections[0]!).getByText('Check')).toBeTruthy()
    // The lockfile is not in any section; it is listed with View in Diff.
    expect(screen.queryByText('pnpm-lock.yaml', { selector: '[data-gfile] *' })).toBeNull()
    const notCovered = screen.getByTestId('review-guide-not-covered')
    fireEvent.click(within(notCovered).getByText('View in Diff'))
    expect(onViewInDiff).toHaveBeenCalledWith('pnpm-lock.yaml')
  })

  it('keeps checklist and Reviewed ticks per PR and head', async () => {
    show()
    const checklist = await screen.findByTestId('review-guide-checklist')
    fireEvent.click(within(checklist).getByLabelText('Route status'))
    fireEvent.click(screen.getAllByLabelText('Reviewed')[1]!)
    expect(
      JSON.parse(localStorage.getItem(`eva-reviews-guide-checklist:${PR.url}@head1`)!),
    ).toEqual([1])
    expect(JSON.parse(localStorage.getItem(`eva-reviews-guide-sections:${PR.url}@head1`)!)).toEqual(
      [1],
    )
  })

  it('renders a v1 folder fallback with whole files and the label', async () => {
    answer = {
      headSha: 'head1',
      source: 'folders',
      error: 'Claude took too long',
      sections: [{ title: 'src', why: '', files: ['src/route.ts'] }],
    }
    show()
    expect((await screen.findByTestId('review-guide-fallback')).textContent).toBe(
      "Grouped by folder (the walkthrough couldn't be written): Claude took too long",
    )
    expect(screen.queryByTestId('review-guide-overview')).toBeNull()
    expect(screen.getAllByTestId('review-diff')).toHaveLength(1)
  })

  it('reloads the PR once when the Guide was read at other commits, then says so with Retry', async () => {
    answer = 'PR changed; regenerating'
    const onStale = vi.fn(async () => true)
    const { rerender } = show(vi.fn(), onStale)
    expect((await screen.findByTestId('review-guide-loading')).textContent).toContain(
      'The PR changed; reloading it',
    )
    expect(onStale).toHaveBeenCalledTimes(1)
    // The reloaded PR (a new object) still isn't what the runner reads: an error, not a spinner.
    rerender(view({ ...PR, headSha: 'head2' }, vi.fn(), onStale))
    const error = await screen.findByTestId('review-guide-error')
    expect(error.textContent).toContain('The PR changed again')
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(onStale).toHaveBeenCalledTimes(1)
    fireEvent.click(within(error).getByText('Retry'))
    expect(onStale).toHaveBeenCalledTimes(2)
    // The next reload is in step: the Guide shows.
    answer = fixture.expected as Guide
    rerender(view({ ...PR, headSha: 'head3' }, vi.fn(), onStale))
    expect(await screen.findAllByTestId('review-guide-section')).toHaveLength(4)
  })

  it('stops waiting when the reload fails, with Retry that reloads again', async () => {
    answer = 'PR changed; regenerating'
    const onStale = vi.fn(async () => false)
    show(vi.fn(), onStale)
    const error = await screen.findByTestId('review-guide-error')
    expect(error.textContent).toContain("reloading it didn't work")
    expect(screen.queryByTestId('review-guide-loading')).toBeNull()
    fireEvent.click(within(error).getByText('Retry'))
    expect(onStale).toHaveBeenCalledTimes(2)
    expect(await screen.findByTestId('review-guide-error')).toBeTruthy()
    expect(screen.queryByTestId('review-guide-loading')).toBeNull()
  })

  it('lists cited hunks the loaded diff lacks and says when the model read part of the PR', async () => {
    const expected = fixture.expected as Guide
    const lost = {
      id: 'src/gone.ts#5,5',
      path: 'src/gone.ts',
      side: 'new' as const,
      start: 5,
      end: 9,
      callouts: [],
    }
    answer = {
      ...expected,
      partial: true,
      sections: expected.sections.map((s, i) =>
        i === 1 ? { ...s, hunks: [...s.hunks!, lost] } : s,
      ),
    }
    const onViewInDiff = vi.fn()
    show(onViewInDiff)
    const sections = await screen.findAllByTestId('review-guide-section')
    const missing = within(sections[1]!).getByTestId('review-guide-missing')
    expect(missing.textContent).toContain('src/gone.ts 5-9')
    fireEvent.click(within(missing).getByText('View in Diff'))
    expect(onViewInDiff).toHaveBeenCalledWith('src/gone.ts')
    expect(screen.getByTestId('review-guide-partial').textContent).toContain('cut for size')
  })
})
