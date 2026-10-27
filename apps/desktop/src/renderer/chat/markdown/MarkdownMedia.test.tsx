import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { mediaUrl } from '../widgets/media-url'
import { Markdown } from './Markdown'
import { clearMediaProbes, urlIsVideo } from './MarkdownMedia'

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
