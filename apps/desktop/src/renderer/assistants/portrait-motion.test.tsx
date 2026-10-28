import { MantineProvider } from '@mantine/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (payload: never) => void>())
vi.mock('../ipc', () => ({
  invoke: vi.fn(),
  on: (channel: string, cb: (payload: never) => void) => {
    handlers.set(channel, cb)
    return () => {}
  },
}))
const windowShown = (shown: boolean): void =>
  (handlers.get('app.windowShown') as (p: { shown: boolean }) => void)({ shown })

import type { Assistant, AssistantStatus } from '@evaos/contract'
import css from './portrait-motion.css?raw'
import { AgentPortrait } from './AgentPortrait'
import { PortraitCard } from './PortraitCard'
import { assistantsStore } from './assistants-store'

const NOVA = {
  style: 'micah',
  seed: 'nova-17',
  options: { glasses: ['round'], glassesProbability: 100 },
  colors: { paper: '#e7f5ff', accent: '#f76707' },
} as const satisfies Assistant['avatar']

function list(status: AssistantStatus): void {
  assistantsStore.setState({
    data: {
      agents: [
        { id: 'nova', title: 'Nova', scope: '', avatar: NOVA, status, file: null, reply: null },
      ],
      relayUp: true,
    },
  })
}

let hidden = false
let reduced = false
const raf = vi.fn((_cb: FrameRequestCallback) => 7)

beforeEach(() => {
  hidden = false
  reduced = false
  raf.mockClear()
  vi.stubGlobal('requestAnimationFrame', raf)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: reduced && query.includes('reduce'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
  document.documentElement.dataset['evaMotion'] = 'on'
  list('not-started')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  assistantsStore.setState({ data: null, starting: {}, failed: {} })
  delete document.documentElement.dataset['evaMotion']
})

const card = () =>
  render(
    <MantineProvider>
      <PortraitCard id="nova" portrait={NOVA} size={84} testId="card" />
    </MantineProvider>,
  )
const figure = () => screen.getByTestId('card').querySelectorAll('.eva-pmc-disc g')
const ringOpacity = () =>
  [...screen.getByTestId('card').querySelectorAll('.eva-pmc-ring circle')].map((c) =>
    c.getAttribute('opacity'),
  )

describe('the animated start card', () => {
  it('greets and animates by animation frame while motion is on', () => {
    card()
    expect(screen.getByTestId('card')).toHaveAttribute('data-state', 'hello')
    expect(raf).toHaveBeenCalledTimes(1)
    act(() => raf.mock.calls[0]![0](0))
    expect(figure().length).toBeGreaterThan(3)
    expect(figure()[0]!.getAttribute('transform')).toMatch(/^matrix\(/)
  })

  it('holds a still face with motion off, the ring still while the agent thinks', () => {
    document.documentElement.dataset['evaMotion'] = 'off'
    card()
    expect(raf).not.toHaveBeenCalled()
    expect(figure().length).toBeGreaterThan(3)
    expect(new Set(ringOpacity())).toEqual(new Set(['0.000']))
    act(() => list('working'))
    expect(screen.getByTestId('card')).toHaveAttribute('data-state', 'thinking')
    expect(new Set(ringOpacity())).toEqual(new Set(['0.800']))
    expect(raf).not.toHaveBeenCalled()
  })

  it('holds still with the system reduced motion too', () => {
    reduced = true
    card()
    expect(raf).not.toHaveBeenCalled()
    expect(figure().length).toBeGreaterThan(3)
  })

  it('does nothing while the page is hidden and resumes when it shows', async () => {
    hidden = true
    card()
    expect(raf).not.toHaveBeenCalled()
    expect(figure()).toHaveLength(0)
    hidden = false
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(raf).toHaveBeenCalledTimes(1)
    expect(document.documentElement.dataset['evaPageHidden']).toBe('false')
    // Turning the app's motion setting off stops it on the spot.
    document.documentElement.dataset['evaMotion'] = 'off'
    await waitFor(() => expect(figure().length).toBeGreaterThan(3))
  })

  it('stops while main says the window is hidden or minimized (the page still reads visible)', () => {
    card()
    expect(raf).toHaveBeenCalledTimes(1)
    act(() => windowShown(false))
    expect(cancelAnimationFrame).toHaveBeenCalled()
    expect(document.documentElement.dataset['evaPageHidden']).toBe('true')
    expect(raf).toHaveBeenCalledTimes(1)
    act(() => windowShown(true))
    expect(document.documentElement.dataset['evaPageHidden']).toBe('false')
    expect(raf).toHaveBeenCalledTimes(2)
  })
})

describe('small portraits', () => {
  it('ring and dot in the state the agent is in', () => {
    render(<AgentPortrait id="nova" className="x" />)
    const el = screen.getByTestId('agent-portrait-nova')
    expect(el).toHaveAttribute('data-state', 'idle')
    expect(el).toHaveAttribute('data-ring', 'false')
    expect(el.querySelector('.eva-pm-dot')).toBeNull()
    expect(el.style.getPropertyValue('--eva-pm-accent')).toBe('#f76707')
    act(() => list('working'))
    expect(el).toHaveAttribute('data-state', 'thinking')
    expect(el).toHaveAttribute('data-ring', 'true')
    expect(screen.getByRole('img', { name: 'Thinking' })).toBeInTheDocument()
    act(() => list('needs-you'))
    expect(el).toHaveAttribute('data-dot', 'orange')
    expect(screen.getByRole('img', { name: 'Needs you' })).toBeInTheDocument()
  })

  it('stop their CSS animation with motion off or reduced, and pause on a hidden page', () => {
    // The animations sit at zero specificity, so the switches below override the ring's too.
    expect(css).toContain(':where(.eva-pm > :first-child) {')
    expect(css).toContain(':where(.eva-pm-ring) {\n  animation: eva-pm-spin')
    expect(css).toContain("html[data-eva-motion='off'] .eva-pm > * {\n  animation: none;")
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s+\.eva-pm > \* \{\s+animation: none;/,
    )
    expect(css).toContain(
      "html[data-eva-page-hidden='true'] .eva-pm > * {\n  animation-play-state: paused;",
    )
  })
})
