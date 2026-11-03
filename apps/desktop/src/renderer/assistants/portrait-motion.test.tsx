import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import assistantsCss from './assistants.css?raw'
import { AgentPortrait } from './AgentPortrait'
import { PortraitCard } from './PortraitCard'
import { CrumbStatus } from './CrumbStatus'
import { assistantsStore } from './assistants-store'
import { overrideSignals } from './motion-store'

const NOVA = {
  style: 'micah',
  seed: 'nova-17',
  options: { glasses: ['round'], glassesProbability: 100 },
  colors: { paper: '#e7f5ff', accent: '#f76707' },
} as const satisfies Assistant['avatar']

function list(status: AssistantStatus, tool: string | null = null): void {
  assistantsStore.setState({
    data: {
      agents: [
        {
          id: 'nova',
          title: 'Nova',
          scope: '',
          avatar: NOVA,
          status,
          tool,
          file: null,
          reply: null,
        },
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

describe('the animated start card', () => {
  it('rests at Idle and animates by animation frame while motion is on', () => {
    card()
    expect(screen.getByTestId('card')).toHaveAttribute('data-state', 'idle')
    // The face alone shows state: no status dot, no working ring.
    expect(screen.getByTestId('card').querySelector('.eva-pmc-dot, .eva-pmc-ring')).toBeNull()
    expect(raf).toHaveBeenCalledTimes(1)
    act(() => raf.mock.calls[0]![0](0))
    expect(figure().length).toBeGreaterThan(3)
    expect(figure()[0]!.getAttribute('transform')).toMatch(/^matrix\(/)
  })

  it('researches with its magnifier while Relay hears a search running', () => {
    const t0 = Date.now()
    let now = t0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    card()
    act(() => list('working', 'web_search'))
    act(() => raf.mock.calls[0]![0](0))
    expect(screen.getByTestId('card')).toHaveAttribute('data-state', 'researching')
    now = t0 + 2_000
    act(() => raf.mock.calls[0]![0](0))
    const lens = screen.getByTestId('card').querySelector('.eva-pmc-lens')!
    expect(Number(lens.getAttribute('opacity'))).toBeGreaterThan(0.5)
    expect(lens.getAttribute('transform')).toMatch(/^translate\(/)
    // The command after it works; the question that follows keeps a resting face.
    act(() => list('working', 'bash'))
    act(() => raf.mock.calls[0]![0](0))
    expect(screen.getByTestId('card')).toHaveAttribute('data-state', 'working')
    act(() => list('needs-you'))
    act(() => raf.mock.calls[0]![0](0))
    expect(screen.getByTestId('card')).toHaveAttribute('data-state', 'idle')
    expect(screen.getByTestId('card').querySelector('.eva-pmc-ring')).toBeNull()
  })

  it('holds the resting face with motion off, while the agent thinks too', () => {
    document.documentElement.dataset['evaMotion'] = 'off'
    card()
    expect(raf).not.toHaveBeenCalled()
    expect(figure().length).toBeGreaterThan(3)
    act(() => list('working'))
    expect(screen.getByTestId('card')).toHaveAttribute('data-state', 'thinking')
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

describe("the card's Extended mode", () => {
  /** Runs the card's frames at 24 fps from now for `seconds`, collecting `probe` after each. */
  function run<T>(seconds: number, probe: () => T): T[] {
    const t0 = Date.now()
    let now = t0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const out: T[] = []
    for (; now < t0 + seconds * 1000; now += 1000 / 24) {
      act(() => raf.mock.calls.at(-1)![0](0))
      out.push(probe())
    }
    return out
  }
  const disc = () => screen.getByTestId('card').querySelector('.eva-pmc-disc svg')!

  it('snoozes behind shut eyelids: the eyes clipped to nothing, the lids drawn over them', () => {
    card()
    overrideSignals('nova', { activityAt: Date.now() - 31 * 60_000 })
    const shut = run(4, () => ({
      state: screen.getByTestId('card').getAttribute('data-state'),
      clipped: disc().querySelector('g[clip-path]') !== null,
      heights: [...disc().querySelectorAll('clipPath rect')].map((r) => r.getAttribute('height')),
      lids: disc().querySelectorAll('g > g:last-child > path').length,
    })).at(-1)!
    overrideSignals('nova', null)
    expect(shut.state).toBe('snoozing')
    expect(shut.clipped).toBe(true)
    expect(shut.heights.length).toBeGreaterThan(0)
    expect(new Set(shut.heights)).toEqual(new Set(['0.00']))
    expect(shut.lids).toBeGreaterThan(0)
  })

  it('morphs the mouth between shapes while it thinks, then draws the parts again', () => {
    card()
    act(() => list('working'))
    const morphing = run(8, () =>
      [...disc().querySelectorAll('g > g:first-child')].some((g) =>
        g.innerHTML.includes('stroke-linecap="round" stroke-linejoin="round"'),
      ),
    )
    expect(morphing.some(Boolean)).toBe(true)
    // Morphs are short: most frames draw the rig's own mouth.
    expect(morphing.filter(Boolean).length).toBeLessThan(morphing.length / 2)
  })

  it('holds the plain resting face, no lids or morphs, with motion off', () => {
    document.documentElement.dataset['evaMotion'] = 'off'
    card()
    overrideSignals('nova', { activityAt: Date.now() - 31 * 60_000 })
    expect(disc().querySelector('g[clip-path]')).toBeNull()
    overrideSignals('nova', null)
  })
})

describe('the status words', () => {
  const words = () =>
    [...screen.getByTestId('agent-crumb-status').querySelectorAll('span')]
      .filter((s) => s.dataset['leaving'] !== 'true')
      .map((s) => s.textContent)

  it('say what the agent is doing, nothing at rest; needing Isaac and failing first', () => {
    render(<CrumbStatus id="nova" />)
    expect(words()).toEqual([])
    act(() => list('working'))
    expect(words()).toEqual(['is thinking'])
    act(() => list('working', 'web_search'))
    expect(words()).toEqual(['is researching'])
    act(() => list('working', 'bash'))
    expect(words()).toEqual(['is working'])
    act(() => list('needs-you'))
    expect(words()).toEqual(['needs you'])
    act(() => assistantsStore.setState({ failed: { nova: 'Relay is down' } }))
    act(() => list('idle'))
    expect(words()).toEqual(['hit a snag'])
    act(() => assistantsStore.setState({ failed: {} }))
    act(() => overrideSignals('nova', { activityAt: Date.now() - 31 * 60_000 }))
    expect(words()).toEqual(['is away'])
    act(() => overrideSignals('nova', null))
  })

  it('crossfade: the old words fade out in place while motion is on, gone at once when off', () => {
    render(<CrumbStatus id="nova" />)
    act(() => list('working'))
    act(() => list('working', 'read'))
    const status = screen.getByTestId('agent-crumb-status')
    const out = status.querySelector('[data-leaving="true"]')!
    expect(out.textContent).toBe('is thinking')
    // jsdom has no AnimationEvent, so React listens for the prefixed name there.
    fireEvent(out, new Event('webkitAnimationEnd', { bubbles: true }))
    expect(status.querySelector('[data-leaving="true"]')).toBeNull()
    document.documentElement.dataset['evaMotion'] = 'off'
    act(() => list('working', 'bash'))
    expect(status.querySelector('[data-leaving="true"]')).toBeNull()
    expect(assistantsCss).toContain('animation: eva-as-status-in 180ms')
  })
})

describe('small portraits', () => {
  it('carry the face state for their breathing, with no ring or dot', () => {
    render(<AgentPortrait id="nova" className="x" />)
    const el = screen.getByTestId('agent-portrait-nova')
    const plain = (): void => {
      expect(el.querySelector('.eva-pm-ring, .eva-pm-dot')).toBeNull()
      expect(el).not.toHaveAttribute('data-ring')
      expect(el).not.toHaveAttribute('data-dot')
    }
    expect(el).toHaveAttribute('data-state', 'idle')
    plain()
    act(() => list('working'))
    expect(el).toHaveAttribute('data-state', 'thinking')
    plain()
    act(() => list('working', 'read'))
    expect(el).toHaveAttribute('data-state', 'researching')
    // Needing Isaac or failing keeps a calm face.
    act(() => list('needs-you'))
    expect(el).toHaveAttribute('data-state', 'idle')
    act(() => assistantsStore.setState({ failed: { nova: 'Relay is down' } }))
    act(() => list('idle'))
    expect(el).toHaveAttribute('data-state', 'idle')
    plain()
  })

  it('stop their CSS animation with motion off or reduced, and pause on a hidden page', () => {
    // The animation sits at zero specificity, so the switches below override it.
    expect(css).toContain(':where(.eva-pm > :first-child) {')
    expect(css).not.toContain('eva-pm-ring')
    expect(css).toContain("html[data-eva-motion='off'] .eva-pm > * {\n  animation: none;")
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s+\.eva-pm > \* \{\s+animation: none;/,
    )
    expect(css).toContain(
      "html[data-eva-page-hidden='true'] .eva-pm > * {\n  animation-play-state: paused;",
    )
  })
})
