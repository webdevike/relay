import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let approveOk = true
const invoke = vi.fn(async (ch: string) => {
  if (ch === 'reviews.approvable') return { ok: true, value: { key: 'ENG-1', state: 'ready' } }
  if (ch === 'reviews.approve') {
    return approveOk
      ? { ok: true, value: { status: 'sent', command: 'x' } }
      : {
          ok: false,
          error: { code: 'astra-failed', message: 'eva-thread.ts could not reach Astra' },
        }
  }
  return { ok: false, error: { code: 'x', message: 'not in tests' } }
})
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [string])),
  on: () => () => {},
}))
vi.mock('../navigation/open-link', () => ({ openLink: () => {} }))

import type { ReviewPr } from '@evaos/contract'
import { Detail } from './ReviewsPage'

const PR = {
  repo: 'eCardSystems/api',
  number: 173,
  title: 'Astra draft',
  url: 'https://github.com/eCardSystems/api/pull/173',
  state: 'OPEN',
  draft: true,
  author: { login: 'webdevike', avatarUrl: null },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  body: '',
  base: 'develop',
  head: 'fix/x',
  additions: 1,
  deletions: 0,
  reviewers: [],
  assignees: [],
  labels: [],
  milestone: null,
  projects: [],
  participants: [],
  commits: [],
  timeline: [],
  checks: [],
  files: [],
  diff: '',
} as unknown as ReviewPr

const show = () =>
  render(
    <MantineProvider>
      <Detail
        pr={PR}
        fetchedAt={Date.now()}
        now={Date.now()}
        onBack={() => {}}
        onRefresh={() => {}}
        onDone={() => {}}
      />
    </MantineProvider>,
  )

beforeEach(() => {
  approveOk = true
  invoke.mockClear()
})

describe('Approve on an auto-work draft', () => {
  it('sends straight to Astra with no confirm and shows Approved', async () => {
    show()
    fireEvent.click(await screen.findByTestId('review-approve'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reviews.approve', {
        repo: PR.repo,
        number: PR.number,
      }),
    )
    expect(screen.queryByTestId('review-approve-confirm')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('review-approve')).toHaveTextContent('Approved'))
  })

  it('shows a quiet inline error when the send fails, and stays tappable', async () => {
    approveOk = false
    show()
    fireEvent.click(await screen.findByTestId('review-approve'))
    expect(await screen.findByTestId('review-approve-error')).toHaveTextContent(
      'could not reach Astra',
    )
    expect(screen.getByTestId('review-approve')).toHaveTextContent('Approve')
  })
})
