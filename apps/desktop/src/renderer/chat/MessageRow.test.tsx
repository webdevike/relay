import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { makeMessage } from '@evaos/chat-core/message'
import { MessageRow, ToolRunRow } from './MessageRow'
import { resetTabsForTests, tabsStore } from '../tabs/tabs-store'
import { resetTilingForTests } from '../tiling/tiling-store'
import { mountTestDock } from '../tiling/test-dock'
import { EVA_COMPUTER_URL } from '@relay/protocol'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../ipc', () => ({ invoke }))
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='
const HASH = 'b'.repeat(64)

const wrap = (ui: React.ReactElement) => render(<MantineProvider>{ui}</MantineProvider>)

describe('MessageRow', () => {
  it('renders a user message as a bubble with its text', () => {
    wrap(<MessageRow m={makeMessage('u', 'user', 'hello there')} />)
    expect(screen.getByText('hello there')).toHaveClass('eva-bubble')
  })

  it('shows a typed direct image link as a picture, not a link, and no empty bubble for a bare one', () => {
    const url = 'https://pixie.haus/sprites/a/b.webp'
    const { container } = wrap(<MessageRow m={makeMessage('u', 'user', url)} />)
    expect(container.querySelector('.eva-bubble')).toBeNull()
    expect(screen.getByTestId('md-image').querySelector('img')).toHaveAttribute(
      'src',
      expect.stringContaining('pixie.haus'),
    )
  })

  it('keeps the words around a typed image link in the bubble', () => {
    wrap(<MessageRow m={makeMessage('u', 'user', 'use https://x.io/p.jpg please')} />)
    expect(screen.getByText('use please')).toHaveClass('eva-bubble')
    expect(screen.getByTestId('md-image')).toBeInTheDocument()
  })

  it('does not paint an empty bubble for an image-only prompt', () => {
    const { container } = wrap(
      <MessageRow m={makeMessage('u', 'user', '', { images: [{ label: 'Image 1', src: PNG }] })} />,
    )
    expect(container.querySelector('.eva-bubble')).toBeNull()
    expect(screen.getByAltText('Image 1 of 1')).toBeInTheDocument()
  })

  it('renders assistant markdown: headings, lists, tables and a labelled code block', () => {
    const text = [
      '### Summary',
      'Fixed **one** bug in `csv.ts`.',
      '',
      '- [x] CSV',
      '- [ ] PDF',
      '',
      '| Source | Rows |',
      '| --- | ---: |',
      '| App | 214 |',
      '',
      '```ts',
      'const x = 1',
      '```',
    ].join('\n')
    const { container } = wrap(<MessageRow m={makeMessage('a', 'assistant', text)} />)
    expect(container.querySelector('h3')?.textContent).toBe('Summary')
    expect(container.querySelector('strong')?.textContent).toBe('one')
    expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(2)
    expect(container.querySelector('td')?.textContent).toBe('App')
    const block = screen.getByTestId('code-block')
    expect(block).toHaveTextContent('ts')
    expect(block.querySelector('pre')!.textContent).toBe('const x = 1')
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
    expect(container.textContent).not.toContain('**')
  })

  it('keeps one sentence per line as separate lines, but not inside code', () => {
    const { container } = wrap(
      <MessageRow m={makeMessage('a', 'assistant', 'First.\nSecond.\n```\na\nb\n```')} />,
    )
    expect(container.querySelector('p br')).not.toBeNull()
    expect(container.querySelector('pre')!.textContent).toBe('a\nb')
  })

  it('streams an unterminated fence as code to the end', () => {
    const { container } = wrap(<MessageRow m={makeMessage('a', 'assistant', 'x\n```\nopen')} />)
    expect(container.querySelector('pre')!.textContent).toBe('open')
  })

  it('never renders raw HTML or script links from a reply', () => {
    const { container } = wrap(
      <MessageRow
        m={makeMessage('a', 'assistant', '<img src=x onerror=alert(1)> [x](javascript:alert(1))')}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript')
  })

  it('opens web links as a page tab of this workspace', async () => {
    invoke.mockResolvedValue({ ok: true, value: {} })
    resetTabsForTests()
    resetTilingForTests()
    tabsStore.setState({ loaded: true })
    const unmount = mountTestDock()
    wrap(<MessageRow m={makeMessage('a', 'assistant', 'see [docs](https://x.example/a)')} />)
    fireEvent.click(screen.getByRole('link', { name: 'docs' }))
    expect(invoke).toHaveBeenCalledWith(
      'browser.createTab',
      expect.objectContaining({ url: 'https://x.example/a' }),
    )
    await Promise.resolve()
    unmount()
  })

  describe('sign-in handoff', () => {
    const HANDOFF = 'Sign in needed: Sketchfab.\n[[signin:https://sketchfab.com/login]]'

    it('shows the card instead of the raw token, with the password form only in an assistant thread', () => {
      const { container, unmount } = wrap(<MessageRow m={makeMessage('a', 'assistant', HANDOFF)} />)
      expect(container.textContent).not.toContain('[[signin')
      expect(screen.getByText('Sign in needed: Sketchfab.')).toBeInTheDocument()
      expect(screen.getByText('Sign in to sketchfab.com')).toBeInTheDocument()
      expect(screen.getByTestId('signin-open-browser')).toBeInTheDocument()
      expect(screen.queryByTestId('signin-use-password')).toBeNull()
      unmount()
      wrap(<MessageRow m={makeMessage('a', 'assistant', HANDOFF)} agent="nova" />)
      expect(screen.getByTestId('signin-use-password')).toBeInTheDocument()
    })

    it("opens Eva's browser screen as a page tab of this workspace", async () => {
      invoke.mockResolvedValue({ ok: true, value: {} })
      resetTabsForTests()
      resetTilingForTests()
      tabsStore.setState({ loaded: true })
      const unmount = mountTestDock()
      wrap(<MessageRow m={makeMessage('a', 'assistant', HANDOFF)} agent="nova" />)
      fireEvent.click(screen.getByTestId('signin-open-browser'))
      expect(invoke).toHaveBeenCalledWith(
        'browser.createTab',
        expect.objectContaining({ url: EVA_COMPUTER_URL }),
      )
      await Promise.resolve()
      unmount()
    })

    it('sends the typed credentials to the host and then shows them submitted', async () => {
      invoke.mockResolvedValue({ ok: true, value: {} })
      wrap(<MessageRow m={makeMessage('s1', 'assistant', HANDOFF)} agent="nova" />)
      fireEvent.click(screen.getByTestId('signin-use-password'))
      fireEvent.change(screen.getByLabelText('Username or email'), {
        target: { value: ' isaac@x.test ' },
      })
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await waitFor(() => expect(screen.getByText('Credentials submitted')).toBeInTheDocument())
      expect(invoke).toHaveBeenCalledWith('signin.submit', {
        agent: 'nova',
        messageId: 's1',
        url: 'https://sketchfab.com/login',
        username: 'isaac@x.test',
        password: 'pw',
      })
      expect(screen.queryByLabelText('Password')).toBeNull()
      expect(screen.queryByTestId('signin-use-password')).toBeNull()
    })

    it("shows the host's refusal and keeps the form", async () => {
      invoke.mockResolvedValue({
        ok: false,
        error: { code: 'internal', message: 'Incorrect username or password.' },
      })
      wrap(<MessageRow m={makeMessage('s2', 'assistant', HANDOFF)} agent="nova" />)
      fireEvent.click(screen.getByTestId('signin-use-password'))
      fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: 'isaac' } })
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } })
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect username or password.')
      expect(screen.getByLabelText('Password')).toBeInTheDocument()
    })
  })

  it('shows thinking inline', () => {
    wrap(<MessageRow m={makeMessage('t', 'thinking', 'secret musings')} />)
    expect(screen.getByText('secret musings')).toHaveClass('eva-thinking')
  })

  it('shows a tool call with its input, a clipped output and failure', () => {
    const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    const m = makeMessage('c-tool0', 'tool', 'bash', {
      detail: 'Running tests',
      tool: { call: 'c', input: 'pnpm test', result: output, isError: true, status: 'failed' },
    })
    const { container } = wrap(<MessageRow m={m} />)
    expect(screen.getByText('bash')).toBeInTheDocument()
    expect(screen.getByText('Running tests')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.getByText('pnpm test').tagName).toBe('PRE')
    const out = container.querySelector('.eva-tool-output')!
    expect(out.textContent).toContain('line 16')
    expect(out.textContent).not.toContain('line 17')
    expect(out.textContent).toContain('… 4 more lines')
  })

  it('folds a run of tools into one line that expands to each call', () => {
    const tool = (id: string, name: string, detail: string) =>
      makeMessage(id, 'tool', name, {
        detail,
        tool: { call: id, input: '', result: null, isError: false, status: 'done' },
      })
    wrap(
      <ToolRunRow
        tools={[tool('a', 'read', 'notes.md'), tool('b', 'edit', 'a.ts'), tool('c', 'read', 'b')]}
      />,
    )
    const head = screen.getByRole('button', { name: 'Used 3 tools · read, edit' })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('notes.md')).toBeNull()
    fireEvent.click(head)
    expect(screen.getByText('notes.md')).toBeInTheDocument()
  })

  it('labels a single folded tool by its intent', () => {
    const m = makeMessage('a', 'tool', 'edit', {
      detail: 'Fix header',
      tool: { call: 'a', input: '', result: null, isError: false, status: 'done' },
    })
    wrap(<ToolRunRow tools={[m]} />)
    expect(screen.getByText('edit · Fix header')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders HTML-looking text literally', () => {
    const { container } = wrap(<MessageRow m={makeMessage('u', 'user', '<b>x</b>')} />)
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<b>x</b>')
  })

  it('renders images as buttons with alt text and a reserved aspect box', () => {
    const m = makeMessage('u', 'user', 'look', {
      images: [
        { label: 'Image 1', src: PNG, width: 480, height: 240 },
        { label: 'Image 2', src: PNG },
      ],
    })
    const { container } = wrap(<MessageRow m={m} />)
    const buttons = container.querySelectorAll('button.eva-chat-image')
    expect(buttons).toHaveLength(2)
    expect(screen.getByAltText('Image 1 of 2')).toBeInTheDocument()
    expect(screen.getByAltText('Image 2 of 2')).toBeInTheDocument()
    expect(container.querySelector('.eva-turn-user')?.firstElementChild).toHaveClass(
      'eva-chat-images',
    )
    expect((buttons[0] as HTMLElement).style.width).toBe('240px')
    expect((buttons[0] as HTMLElement).style.height).toBe('120px')
    expect((buttons[1] as HTMLElement).style.height).toBe('160px')
  })

  it('reads a blob token once and shows the data URL', async () => {
    invoke.mockResolvedValue({ ok: true, value: { dataUrl: PNG, width: 1, height: 1 } })
    const image = { label: 'Image 1', src: `blob:sha256:${HASH}` }
    wrap(<MessageRow m={makeMessage('u1', 'user', 'a', { images: [image] })} />)
    wrap(<MessageRow m={makeMessage('u2', 'user', 'b', { images: [image] })} />)
    await waitFor(() => expect(screen.getAllByAltText('Image 1 of 1')).toHaveLength(2))
    const imgs = screen.getAllByAltText('Image 1 of 1')
    expect(imgs[0]).toHaveAttribute('src', PNG)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('never renders an unsafe src', () => {
    const m = makeMessage('u', 'user', 'x', {
      images: [{ label: 'Image 1', src: 'data:image/svg+xml;base64,PHN2Zz4=' }],
    })
    const { container } = wrap(<MessageRow m={m} />)
    expect(container.querySelector('img')).toBeNull()
  })
})
