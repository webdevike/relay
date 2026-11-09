import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import type { ReactNode } from 'react'
import type {
  ChartSpec,
  EmailsSpec,
  GallerySpec,
  PrSpec,
  RecipeSpec,
  TicketsSpec,
} from '@evaos/chat-core/widget'
import { openLink } from '../../../navigation/open-link'
import { mediaUrl } from '../media-url'
import { AudioWidget, SPEED_KEY } from './AudioWidget'
import { ChartWidget, PALETTE, chartData } from './ChartWidget'
import { CompareWidget } from './CompareWidget'
import { DiagramWidget } from './DiagramWidget'
import { DIFF_ROWS, DiffWidget, diffLines } from './DiffWidget'
import { EmailsWidget } from './EmailsWidget'
import { GalleryWidget } from './GalleryWidget'
import { ImageWidget } from './ImageWidget'
import { ModelWidget } from './ModelWidget'
import { PrWidget } from './PrWidget'
import { RecipeWidget, ingredientGroups } from './RecipeWidget'
import { StatWidget } from './StatWidget'
import { TicketsWidget, stateTone } from './TicketsWidget'
import { VideoWidget } from './VideoWidget'
import { RenderFormScope, RenderMessage, clearRenderReports } from '../render-report'

vi.mock('../../../navigation/open-link', () => ({ openLink: vi.fn() }))

const scene = vi.hoisted(() => ({
  mountModel: vi.fn(),
}))
vi.mock('./model-scene', () => scene)

const show = (ui: ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

beforeEach(() => {
  vi.mocked(openLink).mockClear()
  Object.defineProperty(window, 'eva', {
    configurable: true,
    writable: true,
    value: {
      invoke: vi.fn().mockResolvedValue({ ok: true, value: {} }),
      on: vi.fn(() => () => undefined),
    },
  })
  localStorage.clear()
  clearRenderReports()
})

describe('ChartWidget', () => {
  const spec: ChartSpec = {
    widget: 'chart',
    kind: 'bar',
    title: 'Calls',
    labels: ['W1', 'W2'],
    series: [{ name: 'connected', color: '#A7F3D0', points: [40, 60] }, { points: [1, 2, 3] }],
  }

  it('keys one row per point with labels, falling back to the index', () => {
    const { data, series } = chartData(spec, PALETTE.light)
    expect(data).toEqual([
      { label: 'W1', s0: 40, s1: 1 },
      { label: 'W2', s0: 60, s1: 2 },
      { label: '3', s1: 3 },
    ])
    expect(series).toEqual([
      { name: 's0', label: 'connected', color: '#A7F3D0' },
      { name: 's1', label: 'Series 2', color: PALETTE.light[1] },
    ])
  })

  it('renders its title', () => {
    show(<ChartWidget spec={spec} />)
    expect(screen.getByText('Calls')).toBeInTheDocument()
  })
})

describe('StatWidget', () => {
  it.each([
    ['up', '12%', '+12%', 'green'],
    ['down', '3%', '\u22123%', 'red'],
    ['flat', '0', '0', 'dimmed'],
  ] as const)('colors a %s delta', (direction, value, shown, color) => {
    show(
      <StatWidget
        spec={{ widget: 'stat', label: 'Collected', value: '$7.9k', delta: { value, direction } }}
      />,
    )
    const delta = screen.getByTestId('stat-delta')
    expect(delta).toHaveTextContent(shown)
    expect(delta.style.color).toContain(color)
  })

  it('keeps a sign the agent wrote', () => {
    show(
      <StatWidget
        spec={{ widget: 'stat', label: 'x', value: '1', delta: { value: '-4', direction: 'down' } }}
      />,
    )
    expect(screen.getByTestId('stat-delta')).toHaveTextContent(/^-4$/)
  })
})

describe('TicketsWidget', () => {
  const spec: TicketsSpec = {
    widget: 'tickets',
    title: 'Mine',
    tickets: [
      { id: 'ENG-1', title: 'First', summary: 'One', state: 'In QA', stateType: 'started' },
      {
        id: 'ENG-2',
        title: 'Second',
        summary: 'Two',
        url: 'https://linear.app/x/issue/ENG-2',
        assignee: 'Isaac',
        updated: '2d ago',
      },
    ],
  }

  it('pages with chevrons and dots, one ticket at a time', async () => {
    const user = userEvent.setup()
    show(<TicketsWidget spec={spec} />)
    const page = screen.getByTestId('ticket-page')
    expect(page).toHaveTextContent('First')
    expect(screen.getByLabelText('Previous Ticket')).toBeDisabled()
    await user.click(screen.getByLabelText('Next Ticket'))
    expect(page).toHaveTextContent('Second')
    expect(page).toHaveTextContent('Isaac · 2d ago')
    expect(screen.getByLabelText('Next Ticket')).toBeDisabled()
    await user.click(screen.getByLabelText('Ticket 1 of 2'))
    expect(page).toHaveTextContent('First')
  })

  it('opens the issue in the side browser', async () => {
    const user = userEvent.setup()
    show(<TicketsWidget spec={spec} />)
    await user.click(screen.getByLabelText('Next Ticket'))
    await user.click(screen.getByRole('button', { name: 'Open in Linear' }))
    expect(openLink).toHaveBeenCalledWith('https://linear.app/x/issue/ENG-2')
  })

  it('tones the state pill by state type', () => {
    expect(stateTone('started')).toBe('warn')
    expect(stateTone('completed')).toBe('ok')
    expect(stateTone('triage')).toBe('danger')
    expect(stateTone('unstarted')).toBe('accent')
    expect(stateTone('backlog')).toBe('muted')
    expect(stateTone(undefined)).toBeUndefined()
  })
})

describe('CompareWidget', () => {
  const spec = {
    widget: 'compare' as const,
    before: { src: '/drops/a/b' },
    after: { src: 'https://x.com/after.png', label: 'After · local' },
  }

  it('moves the divider with arrow keys, clamped to the frame', () => {
    show(<CompareWidget spec={spec} />)
    const slider = screen.getByRole('slider')
    expect(slider).toHaveAttribute('aria-valuenow', '50')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider).toHaveAttribute('aria-valuenow', '55')
    fireEvent.keyDown(slider, { key: 'ArrowLeft', shiftKey: true })
    expect(slider).toHaveAttribute('aria-valuenow', '35')
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider).toHaveAttribute('aria-valuenow', '100')
  })

  it('follows a pointer drag', () => {
    show(<CompareWidget spec={spec} />)
    const frame = screen.getByTestId('compare-frame')
    frame.getBoundingClientRect = () => ({ left: 100, width: 200 }) as DOMRect
    fireEvent.pointerDown(frame, { clientX: 150, pointerId: 1 })
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '25')
    fireEvent.pointerMove(frame, { clientX: 260, pointerId: 1 })
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '80')
    fireEvent.pointerUp(frame, { pointerId: 1 })
    fireEvent.pointerMove(frame, { clientX: 120, pointerId: 1 })
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '80')
    expect(frame.style.getPropertyValue('--eva-w-pos')).toBe('80%')
  })

  it('labels the corners and takes the after image aspect', () => {
    show(<CompareWidget spec={spec} />)
    expect(screen.getByText('Before')).toBeInTheDocument()
    expect(screen.getByText('After · local')).toBeInTheDocument()
    const after = screen.getByAltText('After · local') as HTMLImageElement
    expect(after.src).toBe(mediaUrl('https://x.com/after.png'))
    Object.defineProperty(after, 'naturalWidth', { value: 1600 })
    Object.defineProperty(after, 'naturalHeight', { value: 900 })
    fireEvent.load(after)
    expect(screen.getByTestId('compare-frame').style.aspectRatio).toBe(`${16 / 9} / 1`)
  })
})

describe('GalleryWidget', () => {
  const spec: GallerySpec = {
    widget: 'gallery',
    title: 'Refs',
    images: [
      { src: 'https://cdn.x/a.png', title: 'A', caption: 'first', url: 'https://dribbble.com/1' },
      { src: '/drops/x/y', title: 'B' },
    ],
  }

  it('pages through images with captions and the source link', async () => {
    const user = userEvent.setup()
    show(<GalleryWidget spec={spec} />)
    expect(screen.getByAltText('A')).toHaveAttribute('src', mediaUrl('https://cdn.x/a.png'))
    expect(screen.getByText('first')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Open source page'))
    expect(openLink).toHaveBeenCalledWith('https://dribbble.com/1')
    await user.click(screen.getByLabelText('Next Image'))
    expect(screen.getByAltText('B')).toHaveAttribute('src', mediaUrl('/drops/x/y'))
    expect(screen.queryByLabelText('Open source page')).toBeNull()
  })

  it('opens the viewer on the current page', async () => {
    const user = userEvent.setup()
    show(<GalleryWidget spec={spec} />)
    await user.click(screen.getByLabelText('Next Image'))
    await user.click(screen.getByLabelText('Open B'))
    expect(await screen.findByAltText('Image 2 of 2')).toBeInTheDocument()
  })

  it('shows an error line instead of a broken image', () => {
    show(<GalleryWidget spec={spec} />)
    fireEvent.error(screen.getByAltText('A'))
    expect(screen.getByText("Couldn't load image")).toBeInTheDocument()
    expect(screen.queryByAltText('A')).toBeNull()
  })
})

describe('ImageWidget and DiagramWidget', () => {
  it('draws an image at its aspect and opens the viewer', async () => {
    const user = userEvent.setup()
    show(
      <ImageWidget
        spec={{ widget: 'image', src: '/drops/a/b', alt: 'Shot', caption: 'Home', aspect: 2 }}
      />,
    )
    expect(screen.getByLabelText('Open Shot')).toHaveStyle({ aspectRatio: '2' })
    expect(screen.getByText('Home')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Open Shot'))
    expect(await screen.findByAltText('Image 1 of 1')).toHaveAttribute(
      'src',
      mediaUrl('/drops/a/b'),
    )
  })

  it('titles a diagram and caps tall ones', () => {
    show(<DiagramWidget spec={{ widget: 'diagram', src: '/drops/d/e', title: 'Flow' }} />)
    expect(screen.getByText('Flow')).toBeInTheDocument()
    const img = screen.getByAltText('Flow')
    Object.defineProperty(img, 'naturalWidth', { value: 100 })
    Object.defineProperty(img, 'naturalHeight', { value: 400 })
    fireEvent.load(img)
    expect(screen.getByLabelText('Open Flow').style.aspectRatio).toBe(`${1 / 1.5} / 1`)
  })
})

describe('AudioWidget', () => {
  it('cycles the speed pill and remembers it across clips', async () => {
    const user = userEvent.setup()
    const { unmount } = show(<AudioWidget spec={{ widget: 'audio', src: '/drops/a/b' }} />)
    const pill = screen.getByLabelText('Playback speed')
    expect(pill).toHaveTextContent('1x')
    for (const label of ['1.25x', '1.5x', '1.75x', '2x', '1x', '1.25x']) {
      await user.click(pill)
      expect(pill).toHaveTextContent(label)
    }
    expect(localStorage.getItem(SPEED_KEY)).toBe('1.25')
    const audio = document.querySelector('audio')!
    expect(audio.playbackRate).toBe(1.25)
    unmount()
    show(<AudioWidget spec={{ widget: 'audio', src: '/drops/c/d', title: 'Clip' }} />)
    expect(screen.getByLabelText('Playback speed')).toHaveTextContent('1.25x')
  })

  it('shows elapsed and total time, and an error line when the clip fails', () => {
    show(<AudioWidget spec={{ widget: 'audio', src: '/drops/a/b' }} />)
    const audio = document.querySelector('audio')!
    expect(audio.getAttribute('src')).toBe(mediaUrl('/drops/a/b'))
    Object.defineProperty(audio, 'duration', { value: 125, configurable: true })
    fireEvent.loadedMetadata(audio)
    expect(screen.getByText('0:00 / 2:05')).toBeInTheDocument()
    fireEvent.error(audio)
    expect(screen.getByText("Couldn't load audio")).toBeInTheDocument()
  })
})

describe('VideoWidget', () => {
  it('plays from the media protocol at the video aspect', () => {
    show(<VideoWidget spec={{ widget: 'video', src: '/drops/a/b', title: 'Film' }} />)
    const video = screen.getByLabelText('Film') as HTMLVideoElement
    expect(video.getAttribute('src')).toBe(mediaUrl('/drops/a/b'))
    expect(video.controls).toBe(true)
    Object.defineProperty(video, 'videoWidth', { value: 400 })
    Object.defineProperty(video, 'videoHeight', { value: 300 })
    fireEvent.loadedMetadata(video)
    expect(video.parentElement!.style.aspectRatio).toBe(`${4 / 3} / 1`)
    fireEvent.error(video)
    expect(screen.getByText("Couldn't load video")).toBeInTheDocument()
  })
})

describe('ModelWidget', () => {
  it('mounts the scene and tags it 3D once loaded', async () => {
    const dispose = vi.fn()
    let loaded = (): void => {}
    scene.mountModel.mockImplementation((_host, _url, options) => {
      loaded = options.onLoad
      return dispose
    })
    const { unmount } = show(
      <ModelWidget
        spec={{ widget: 'model', src: '/drops/m/n', caption: 'GLB', autoRotate: true }}
      />,
    )
    await vi.waitFor(() => expect(scene.mountModel).toHaveBeenCalled())
    const [, url, options] = scene.mountModel.mock.calls[0]!
    expect(url).toBe(mediaUrl('/drops/m/n'))
    expect(options.autoRotate).toBe(true)
    expect(screen.queryByText('3D')).toBeNull()
    act(() => loaded())
    expect(screen.getByText('3D')).toBeInTheDocument()
    expect(screen.getByText('GLB')).toBeInTheDocument()
    unmount()
    expect(dispose).toHaveBeenCalled()
  })

  it('shows the failure in the frame', async () => {
    scene.mountModel.mockImplementation((_host, _url, options) => {
      options.onError("Couldn't load model")
      return () => {}
    })
    show(<ModelWidget spec={{ widget: 'model', src: '/drops/m/n' }} />)
    expect(await screen.findByText("Couldn't load model")).toBeInTheDocument()
  })

  it('tells the agent when it fails in an openui block of a chat bubble, with the loader reason', async () => {
    scene.mountModel.mockImplementation((_host, _url, options) => {
      options.onError("Couldn't load model", 'Unexpected token')
      return () => {}
    })
    show(
      <RenderMessage.Provider value={{ thread: 'session:s1', message: 'assistant@3' }}>
        <RenderFormScope.Provider value="openui">
          <ModelWidget spec={{ widget: 'model', src: '/drops/m/n' }} />
        </RenderFormScope.Provider>
      </RenderMessage.Provider>,
    )
    await screen.findByText("Couldn't load model")
    expect(window.eva.invoke).toHaveBeenCalledWith('render.failed', {
      thread: 'session:s1',
      message: 'assistant@3',
      kind: 'model',
      form: 'openui',
      src: '/drops/m/n',
      error: "Couldn't load model: Unexpected token",
    })
  })

  it('reports nothing outside a chat bubble', async () => {
    scene.mountModel.mockImplementation((_host, _url, options) => {
      options.onError("Couldn't load model", 'boom')
      return () => {}
    })
    show(<ModelWidget spec={{ widget: 'model', src: '/drops/m/n' }} />)
    await screen.findByText("Couldn't load model")
    expect(window.eva.invoke).not.toHaveBeenCalledWith('render.failed', expect.anything())
  })
})

describe('DiffWidget', () => {
  it('numbers the new file and marks change runs', () => {
    const patch =
      '--- a/x.rs\n+++ b/src/x.rs\n@@ -1,3 +10,3 @@ fn main\n keep\n-old\n+new\n keep\n+added\n'
    const { lines, file } = diffLines(patch)
    expect(file).toBe('src/x.rs')
    expect(lines.map((l) => l.number)).toEqual([null, 10, null, 11, 12, 13])
    expect(lines.map((l) => l.block)).toEqual([null, null, 'modified', 'modified', null, 'added'])
    expect(lines[0]).toMatchObject({ kind: 'hunk', text: 'fn main' })
  })

  it('shows 60 rows, then the rest on "Show N more", without +/- markers', async () => {
    const user = userEvent.setup()
    const body = Array.from({ length: 70 }, (_, i) => `+line ${i}`).join('\n')
    show(
      <DiffWidget
        spec={{ widget: 'diff', file: 'src/a.txt', patch: `@@ -0,0 +1,70 @@\n${body}` }}
      />,
    )
    expect(screen.getAllByTestId('diff-row')).toHaveLength(DIFF_ROWS)
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText('src')).toBeInTheDocument()
    expect(screen.getByText('+70')).toBeInTheDocument()
    expect(screen.getAllByTestId('diff-row')[1]).toHaveTextContent(/^1line 0$/)
    await user.click(screen.getByRole('button', { name: 'Show 11 more' }))
    expect(screen.getAllByTestId('diff-row')).toHaveLength(71)
  })

  it('collapses from its header', async () => {
    const user = userEvent.setup()
    show(<DiffWidget spec={{ widget: 'diff', patch: '@@ -1 +1 @@\n-a\n+b' }} />)
    const header = screen.getByRole('button', { name: /Changes/ })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    await user.click(header)
    expect(screen.queryAllByTestId('diff-row')).toHaveLength(0)
  })
})

describe('EmailsWidget', () => {
  const spec: EmailsSpec = {
    widget: 'emails',
    title: 'Inbox',
    emails: [
      {
        from: 'Noah',
        subject: 'Deploy',
        snippet: 'Long body',
        date: '9:12',
        unread: true,
        url: 'https://mail.google.com/mail/u/0/#all/abc',
      },
      { from: 'Steve', subject: 'QA' },
    ],
  }

  it('expands a snippet on click and opens a thread from its icon', async () => {
    const user = userEvent.setup()
    show(<EmailsWidget spec={spec} />)
    const [first, second] = screen.getAllByTestId('email-row')
    expect(within(first!).getByLabelText('Unread')).toBeInTheDocument()
    expect(within(second!).queryByLabelText('Unread')).toBeNull()
    expect(first).toHaveAttribute('data-expanded', 'false')
    await user.click(first!)
    expect(first).toHaveAttribute('data-expanded', 'true')
    await user.click(within(first!).getByLabelText('Open email'))
    expect(openLink).toHaveBeenCalledWith('https://mail.google.com/mail/u/0/#all/abc')
    expect(first).toHaveAttribute('data-expanded', 'true')
    expect(within(second!).queryByLabelText('Open email')).toBeNull()
  })
})

describe('RecipeWidget', () => {
  const spec: RecipeSpec = {
    widget: 'recipe',
    title: 'Tacos',
    meta: ['15 minutes', 'Serves 6'],
    ingredients: [
      { section: 'Tacos', item: '1 lb pork' },
      { item: '6 tortillas' },
      { section: 'Glaze', item: 'Soy sauce' },
    ],
    directions: ['Mix.', 'Sear.'],
    source: 'https://www.example.com/recipe',
  }

  it('groups ingredients where a section starts', () => {
    expect(ingredientGroups(spec.ingredients).map((g) => [g.section, g.items.length])).toEqual([
      ['Tacos', 2],
      ['Glaze', 1],
    ])
  })

  it('keeps checked ingredients across tabs and shows the details', async () => {
    const user = userEvent.setup()
    show(<RecipeWidget spec={spec} />)
    const pork = screen.getByRole('checkbox', { name: '1 lb pork' })
    await user.click(pork)
    expect(pork).toBeChecked()
    expect(screen.getByText('1 lb pork')).toHaveClass('eva-w-recipe-done')
    await user.click(screen.getByRole('tab', { name: 'Details' }))
    expect(screen.getByText('15 minutes · Serves 6')).toBeVisible()
    expect(screen.getByText('Sear.')).toBeVisible()
    await user.click(screen.getByText('example.com'))
    expect(openLink).toHaveBeenCalledWith('https://www.example.com/recipe')
    await user.click(screen.getByRole('tab', { name: 'Ingredients' }))
    expect(screen.getByRole('checkbox', { name: '1 lb pork' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '6 tortillas' })).not.toBeChecked()
  })
})

describe('PrWidget', () => {
  const spec: PrSpec = {
    widget: 'pr',
    repo: 'eva/relay',
    number: 412,
    title: 'Fix login',
    state: 'open',
    author: 'isaac',
    branch: 'fix/login',
    body: 'Fixes **login**.',
    reviewers: [{ name: 'Noah', state: 'approved' }],
    checks: [
      { name: 'lint', status: 'success' },
      { name: 'e2e', status: 'failure', duration: '6m' },
    ],
    files: [{ file: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' }],
  }

  it('shows the header, overview, checks and files tabs', async () => {
    const user = userEvent.setup()
    show(<PrWidget spec={spec} />)
    expect(screen.getByText('eva/relay #412')).toBeInTheDocument()
    expect(screen.getByText('isaac · fix/login → main')).toBeInTheDocument()
    expect(screen.getByText('login')).toBeInTheDocument()
    expect(screen.getByText('Approved')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Checks · 1 failed' }))
    expect(screen.getByText('6m')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Files · 1' }))
    expect(screen.getByText('a.ts')).toBeVisible()
  })
})
