import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { mediaUrl } from '../widgets/media-url'
import { Markdown } from './Markdown'
import { clearMediaProbes, urlIsVideo } from './MarkdownMedia'
import { RenderMessage, clearRenderReports } from '../widgets/render-report'
import { invoke } from '../../ipc'
import { collectMessageImages } from './collect-images'
import { dismissTop } from '../../hotkeys/dismiss'

vi.mock('../../ipc', () => ({ invoke: vi.fn(), on: vi.fn() }))
vi.mock('../widgets/rich/model-scene', () => ({ mountModel: vi.fn() }))

/** What main's relay-media: HEAD answers per src: a content type, or a failure status. */
let served: Record<string, string | number> = {}
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  expect(init?.method).toBe('HEAD')
  const src = new URL(url).searchParams.get('src')!
  const answer = served[src] ?? 404
  return typeof answer === 'number'
    ? new Response(null, { status: answer })
    : new Response(null, { status: 200, headers: { 'Content-Type': answer } })
})

beforeEach(() => {
  clearMediaProbes()
  clearRenderReports()
  vi.mocked(invoke).mockReset()
  vi.mocked(invoke).mockResolvedValue({ ok: true, value: { sent: true } })
  served = {}
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const show = (text: string) =>
  render(
    <MantineProvider>
      <Markdown text={text} />
    </MantineProvider>,
  )

describe('markdown media: image or inline video', () => {
  it('plays a drop served as video/* inline, with its poster and native controls', async () => {
    served = { '/drops/vid1/tok1': 'video/mp4', '/drops/vid1/tok1/poster': 'image/jpeg' }
    show('Here it is:\n\n![Demo clip](/drops/vid1/tok1)')
    const video = (await screen.findByLabelText('Demo clip')) as HTMLVideoElement
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('src')).toBe(mediaUrl('/drops/vid1/tok1'))
    expect(video.getAttribute('poster')).toBe(mediaUrl('/drops/vid1/tok1/poster'))
    expect(video.controls).toBe(true)
    expect(video.getAttribute('preload')).toBe('metadata')
    expect(video.hasAttribute('playsinline')).toBe(true)
    expect(video.autoplay).toBe(false)
    expect(video.muted).toBe(false)
    expect(screen.getByTestId('md-video')).toHaveTextContent('Demo clip')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('leaves the poster off when the host made none', async () => {
    served = { '/drops/vid2/tok2': 'video/webm' }
    show('![Clip](/drops/vid2/tok2)')
    const video = await screen.findByLabelText('Clip')
    expect(video.tagName).toBe('VIDEO')
    expect(video.hasAttribute('poster')).toBe(false)
  })

  it('keeps a drop served as an image an <img>, and asks only once per drop', async () => {
    served = { '/drops/img1/tok1': 'image/png' }
    const first = show('![Shot](/drops/img1/tok1)')
    expect(screen.getByTestId('md-media-pending')).toBeInTheDocument()
    const img = await screen.findByAltText('Shot')
    expect(img.tagName).toBe('IMG')
    expect(img).toHaveAttribute('src', mediaUrl('/drops/img1/tok1'))
    expect(document.querySelector('video')).toBeNull()
    first.unmount()
    // A remount (the virtual list scrolling back) draws at once from the settled probe.
    show('![Shot](/drops/img1/tok1)')
    expect(screen.getByAltText('Shot').tagName).toBe('IMG')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to an image when the drop cannot be probed', async () => {
    served = { '/drops/gone/tok': 503 }
    show('![Gone](/drops/gone/tok)')
    expect((await screen.findByAltText('Gone')).tagName).toBe('IMG')
  })

  it('plays an https .mp4 inline and keeps an https .png an image, without probing', () => {
    show('![Film](https://cdn.example.com/a/film.mp4)\n\n![Pic](https://cdn.example.com/pic.png)')
    const video = screen.getByLabelText('Film')
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('src')).toBe(mediaUrl('https://cdn.example.com/a/film.mp4'))
    expect(video.hasAttribute('poster')).toBe(false)
    expect(screen.getByAltText('Pic').tagName).toBe('IMG')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('opens a clicked image full size in the image viewer; Escape closes it', async () => {
    show('![Systems map](https://cdn.example.com/map.png)')
    expect(screen.queryByAltText('Image 1 of 1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open Systems map' }))
    const shown = await screen.findByAltText('Image 1 of 1')
    expect(shown).toHaveAttribute('src', mediaUrl('https://cdn.example.com/map.png'))
    // Esc runs the topmost dismisser (the app's hotkey layer calls dismissTop).
    act(() => void dismissTop())
    await waitFor(() => expect(screen.queryByAltText('Image 1 of 1')).toBeNull())
  })

  it('a linked image follows its link instead of opening the viewer', () => {
    show('[![Logo](https://cdn.example.com/logo.png)](https://example.com)')
    expect(screen.getByAltText('Logo').closest('a')).toHaveAttribute('href', 'https://example.com')
    expect(screen.queryByTestId('md-image')).toBeNull()
  })

  it('opens every image of the message in order, from the clicked one, skipping video and linked images', async () => {
    show(
      [
        '![A](https://cdn.example.com/a.png)',
        '![Clip](https://cdn.example.com/c.mp4)',
        '[![Linked](https://cdn.example.com/l.png)](https://example.com)',
        '![B](https://cdn.example.com/b.png)',
        '![C](https://cdn.example.com/c.png)',
      ].join('\n\n'),
    )
    expect(collectMessageImages(screen.getByRole('button', { name: 'Open B' }))).toEqual({
      images: ['A', 'B', 'C'].map((n) => ({
        label: n,
        src: mediaUrl(`https://cdn.example.com/${n.toLowerCase()}.png`),
      })),
      start: 1,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open B' }))
    expect(await screen.findByAltText('Image 2 of 3')).toHaveAttribute(
      'src',
      mediaUrl('https://cdn.example.com/b.png'),
    )
    fireEvent.click(screen.getByTestId('viewer-next'))
    expect(await screen.findByAltText('Image 3 of 3')).toBeInTheDocument()
    expect(screen.getByTestId('viewer-next')).toBeDisabled()
    fireEvent.click(screen.getByTestId('viewer-prev'))
    fireEvent.click(screen.getByTestId('viewer-prev'))
    expect(await screen.findByAltText('Image 1 of 3')).toHaveAttribute(
      'src',
      mediaUrl('https://cdn.example.com/a.png'),
    )
  })
})

describe('markdown media: render failures reach the agent', () => {
  const AT = { thread: 'assistant:astra', message: 'assistant@7' }
  const inBubble = (text: string) => (
    <MantineProvider>
      <RenderMessage.Provider value={AT}>
        <Markdown text={text} />
      </RenderMessage.Provider>
    </MantineProvider>
  )
  const reports = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === 'render.failed')

  it('draws a GLB drop as a file card, never an <img>, and reports it once as a model', async () => {
    served = { '/drops/glb/tok': 'model/gltf-binary' }
    const { rerender } = render(inBubble('![Robot](/drops/glb/tok)'))
    const card = await screen.findByTestId('md-file')
    expect(card).toHaveTextContent('Robot')
    expect(card).toHaveTextContent("Can't show this inline")
    expect(screen.queryByAltText('Robot')).toBeNull()
    rerender(inBubble('![Robot](/drops/glb/tok)\n\nmore'))
    await waitFor(() => expect(reports()).toHaveLength(1))
    expect(reports()[0]![1]).toEqual({
      ...AT,
      kind: 'model',
      form: 'markdown',
      src: '/drops/glb/tok',
      error: 'served model/gltf-binary: 3D models only render in an openui Model block',
    })
  })

  it('reports a non-media drop as an image markdown cannot show', async () => {
    served = { '/drops/pdf/tok': 'application/pdf' }
    render(inBubble('![Doc](/drops/pdf/tok)'))
    await screen.findByTestId('md-file')
    await waitFor(() => expect(reports()).toHaveLength(1))
    expect(reports()[0]![1]).toMatchObject({
      kind: 'image',
      error: "served application/pdf: markdown can't show it",
    })
  })

  it('reports a failed probe with its HTTP status', async () => {
    served = { '/drops/gone/tok': 404 }
    render(inBubble('![Gone](/drops/gone/tok)'))
    await screen.findByAltText('Gone')
    await waitFor(() => expect(reports()).toHaveLength(1))
    expect(reports()[0]![1]).toMatchObject({ kind: 'image', error: 'HTTP 404' })
  })

  it('reports a broken image once, however often it re-renders', async () => {
    const { rerender } = render(inBubble('![Pic](https://x.com/a.png)'))
    fireEvent.error(screen.getByAltText('Pic'))
    expect(screen.getByTestId('md-image-error')).toHaveTextContent('Image failed to load')
    rerender(inBubble('![Pic](https://x.com/a.png) again'))
    expect(reports()).toEqual([
      [
        'render.failed',
        {
          ...AT,
          kind: 'image',
          form: 'markdown',
          src: 'https://x.com/a.png',
          error: 'image failed to load',
        },
      ],
    ])
  })

  it('reports nothing outside a chat bubble', async () => {
    served = { '/drops/glb2/tok': 'model/gltf-binary' }
    show('![Robot](/drops/glb2/tok)\n\n![Pic](https://x.com/b.png)')
    await screen.findByTestId('md-file')
    fireEvent.error(screen.getByAltText('Pic'))
    expect(reports()).toEqual([])
  })
})

describe('urlIsVideo', () => {
  it('reads the URL path extension only', () => {
    for (const ext of ['mp4', 'webm', 'mov', 'm4v', 'MP4'])
      expect(urlIsVideo(`https://x.com/v.${ext}`)).toBe(true)
    expect(urlIsVideo('https://x.com/v.mp4?sig=abc#t=5')).toBe(true)
    expect(urlIsVideo('https://x.com/v.png')).toBe(false)
    expect(urlIsVideo('https://x.com/watch?v=clip.mp4')).toBe(false)
    expect(urlIsVideo('/drops/a/b')).toBe(false)
    expect(urlIsVideo('~/clip.mp4')).toBe(false)
  })
})
