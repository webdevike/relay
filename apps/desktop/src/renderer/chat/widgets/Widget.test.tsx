import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import type { ReactNode } from 'react'
import { CALCULATOR } from '@evaos/chat-core/openui/calculator.fixture'
import { openLink } from '../../navigation/open-link'
import { Markdown } from '../markdown/Markdown'
import { WidgetActions, WidgetScope } from './actions'
import { WidgetBlock } from './Widget'
import { invoke } from '../../ipc'

vi.mock('../../navigation/open-link', () => ({ openLink: vi.fn() }))
vi.mock('../../ipc', () => ({ invoke: vi.fn(), on: vi.fn() }))
vi.mock('./rich/model-scene', () => ({ mountModel: vi.fn() }))
// A spec that validates but throws while drawing must degrade, not take the chat down.
vi.mock('./rich/DiagramWidget', () => ({
  DiagramWidget: () => {
    throw new Error('boom')
  },
}))

const show = (ui: ReactNode, reply = vi.fn(), canReply = true) => {
  render(
    <MantineProvider>
      <WidgetActions.Provider value={{ reply, canReply }}>{ui}</WidgetActions.Provider>
    </MantineProvider>,
  )
  return reply
}

const widget = (spec: object) => <WidgetBlock json={JSON.stringify(spec)} />
const fence = (spec: object) => ['Here:', '', '```ui', JSON.stringify(spec), '```', ''].join('\n')

describe('Markdown ```ui fences', () => {
  it('renders a closed fence as the widget', () => {
    show(<Markdown text={fence({ widget: 'badge', label: 'Dev green', tone: 'ok' })} />)
    expect(screen.getByTestId('widget')).toHaveAttribute('data-widget', 'badge')
    expect(screen.getByText('Dev green')).toBeInTheDocument()
    expect(screen.queryByTestId('code-block')).toBeNull()
  })

  it('keeps a still-streaming fence as plain JSON code', () => {
    show(<Markdown text={'Here:\n\n```ui\n{"widget":"badge","label":"Dev green"}'} />)
    expect(screen.queryByTestId('widget')).toBeNull()
    expect(screen.getByTestId('code-block')).toHaveTextContent('json')
    expect(screen.queryByText("Widget couldn't render")).toBeNull()
  })

  it('shows a closed fence that fails validation as code under a warning header', () => {
    show(<Markdown text={fence({ widget: 'sparkle' })} />)
    const head = screen.getByText("Widget couldn't render")
    expect(head).toHaveAttribute('data-invalid', 'true')
    expect(screen.getByTestId('code-block')).toHaveTextContent('"widget": "sparkle"')
  })

  it('finds the closing fence inside a quote and with a longer fence', () => {
    show(
      <Markdown
        text={
          '> ```ui\n> {"widget":"divider"}\n> ```\n\n````ui\n{"widget":"text","text":"Long"}\n````\n'
        }
      />,
    )
    expect(screen.getAllByTestId('widget')).toHaveLength(2)
  })

  it('leaves other fences as code', () => {
    show(<Markdown text={'```ts\nlet a = 1\n```\n'} />)
    expect(screen.getByTestId('code-block')).toHaveTextContent('ts')
  })
})

describe('Markdown ```openui fences', () => {
  const program = [
    'root = Card([stats, Text("Done")], "Brief")',
    'stats = Stack([Stat("Open", "12"), Stat("Review", "1")], "horizontal")',
  ].join('\n')

  it('renders a closed block through the widget registry', () => {
    show(<Markdown text={`Here:\n\n\`\`\`openui\n${program}\n\`\`\`\n`} />)
    const root = screen.getByTestId('widget')
    expect(root).toHaveAttribute('data-widget', 'card')
    expect(root).not.toHaveAttribute('data-partial')
    expect(within(root).getAllByTestId('widget-stat')).toHaveLength(2)
    expect(within(root).getByText('Done')).toBeInTheDocument()
    expect(screen.queryByTestId('code-block')).toBeNull()
  })

  it('renders a still-streaming block live, growing as statements arrive', () => {
    const cut = program.indexOf('Stat("Review"')
    const { rerender } = render(
      <MantineProvider>
        <Markdown text={`\`\`\`openui\n${program.slice(0, cut)}`} />
      </MantineProvider>,
    )
    const root = screen.getByTestId('widget')
    expect(root).toHaveAttribute('data-partial', 'true')
    expect(within(root).getAllByTestId('widget-stat')).toHaveLength(1)
    rerender(
      <MantineProvider>
        <Markdown text={`\`\`\`openui\n${program}`} />
      </MantineProvider>,
    )
    expect(within(screen.getByTestId('widget')).getAllByTestId('widget-stat')).toHaveLength(2)
  })

  it('shows plain source while nothing renders yet, without the warning', () => {
    show(<Markdown text={'```openui\nroot = Card(['} />)
    expect(screen.queryByTestId('widget')).toBeNull()
    expect(screen.getByTestId('code-block')).toHaveTextContent('openui')
    expect(screen.queryByText("Widget couldn't render")).toBeNull()
  })

  it('shows a closed block whose root does not render as code under the warning header', () => {
    show(<Markdown text={'```openui\nroot = Link("x", "not a url")\n```\n'} />)
    expect(screen.getByText("Widget couldn't render")).toHaveAttribute('data-invalid', 'true')
    expect(screen.getByTestId('code-block')).toHaveTextContent('root = Link("x", "not a url")')
  })

  const openui = (program: string) => `Here:\n\n\`\`\`openui\n${program}\n\`\`\`\n`
  const press = async (...keys: string[]) => {
    for (const key of keys) await userEvent.click(screen.getByRole('button', { name: key }))
  }

  // The calculator's one Text is its display.
  it('runs the calculator on the device: 1 2 + 7 = shows 19, sending nothing', async () => {
    const reply = show(<Markdown text={openui(CALCULATOR)} />, vi.fn(), false)
    expect(screen.getByTestId('widget-text')).toHaveTextContent(/^0$/)
    await press('1', '2', '+', '7')
    expect(screen.getByTestId('widget-text')).toHaveTextContent(/^7$/)
    await press('=')
    expect(screen.getByTestId('widget-text')).toHaveTextContent(/^19$/)
    await press('Clear')
    expect(screen.getByTestId('widget-text')).toHaveTextContent(/^0$/)
    expect(reply).not.toHaveBeenCalled()
  })

  it("keeps a block's state when its message row remounts", async () => {
    const row = (
      <MantineProvider>
        <WidgetScope.Provider value="msg-remount">
          <Markdown text={openui(CALCULATOR)} />
        </WidgetScope.Provider>
      </MantineProvider>
    )
    const first = render(row)
    await press('4', '×', '5', '=')
    expect(screen.getByTestId('widget-text')).toHaveTextContent(/^20$/)
    first.unmount()
    render(row)
    expect(screen.getByTestId('widget-text')).toHaveTextContent(/^20$/)
  })

  it("runs a reply widget's Query against the host wherever it is drawn (chat, subagent view)", async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true, value: { ok: true, data: { total: 7 } } })
    const program = [
      'root = Stat("Open items", "" + items.total)',
      'items = Query("work_items", {}, {total: 0}, 30)',
    ].join('\n')
    show(
      <WidgetScope.Provider value="msg-query">
        <Markdown text={openui(program)} />
      </WidgetScope.Provider>,
    )
    expect(await screen.findByText('7')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('boards.query', { tool: 'work_items', args: {} })
  })

  it('binds a field to a $variable and sends what an action hands back', async () => {
    const program = [
      'root = Stack([field, Text("Hi " + $name), ask])',
      '$name = ""',
      'field = Input("Name", null, null, null, $name)',
      'ask = Button("Ask", Action([@Set($count, $count + 1), @ToAssistant("who is " + $name)]))',
      '$count = 0',
    ].join('\n')
    const reply = show(<Markdown text={openui(program)} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada')
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Ada')
    expect(screen.getByText('Hi Ada')).toBeInTheDocument()
    await press('Ask')
    expect(reply).toHaveBeenCalledWith('who is Ada')
  })
})

describe('WidgetBlock', () => {
  it('frames a compact root once, and a root card is the frame itself', () => {
    show(
      <>
        {widget({ widget: 'rows', rows: [{ label: 'ENG-1', value: 'In QA', tone: 'warn' }] })}
        {widget({
          widget: 'card',
          title: 'Brief',
          children: [{ widget: 'text', text: 'Hello' }, { widget: 'divider' }],
        })}
        {widget({ widget: 'callout', text: 'Bare at the root' })}
      </>,
    )
    const [rows, card, callout] = screen.getAllByTestId('widget')
    expect(within(rows!).getAllByTestId('widget-frame')).toHaveLength(1)
    expect(within(card!).getAllByTestId('widget-frame')).toHaveLength(1)
    expect(within(card!).getByText('Brief')).toBeInTheDocument()
    expect(within(callout!).queryByTestId('widget-frame')).toBeNull()
  })

  it('lays a root row of stats out on hairlines', () => {
    show(
      widget({
        widget: 'stack',
        direction: 'horizontal',
        children: [
          { widget: 'stat', label: 'Open', value: '12' },
          { widget: 'stat', label: 'Review', value: '1' },
        ],
      }),
    )
    expect(screen.getByTestId('widget-stats-row')).toBeInTheDocument()
    expect(screen.queryByTestId('widget-frame')).toBeNull()
  })

  it('fills cells with buttons, keeps a compact card narrow, and draws a display readout', () => {
    show(
      widget({
        widget: 'card',
        width: 'compact',
        children: [
          { widget: 'text', text: '42', style: 'display', align: 'right' },
          {
            widget: 'grid',
            columns: 2,
            children: [
              { widget: 'button', label: '7', reply: '7', variant: 'secondary' },
              { widget: 'button', label: '8', reply: '8', variant: 'secondary' },
            ],
          },
          {
            widget: 'stack',
            direction: 'horizontal',
            children: [{ widget: 'button', label: 'Go', reply: 'go', variant: 'primary' }],
          },
          { widget: 'button', label: 'Alone', reply: 'alone', variant: 'subtle' },
        ],
      }),
    )
    expect(screen.getByTestId('widget-frame')).toHaveAttribute('data-width', 'compact')
    const text = screen.getByTestId('widget-text')
    expect(text).toHaveAttribute('data-style', 'display')
    expect(text).toHaveStyle({ textAlign: 'right' })
    const key = (name: string) => screen.getByRole('button', { name })
    for (const name of ['7', '8']) {
      expect(key(name)).toHaveAttribute('data-cell', 'grid')
      expect(key(name)).toHaveAttribute('data-block', 'true')
      expect(key(name)).toHaveStyle({ height: 'calc(2.5rem * var(--mantine-scale))' })
    }
    expect(key('Go')).toHaveAttribute('data-cell', 'row')
    expect(key('Go')).toHaveAttribute('data-block', 'true')
    expect(key('Alone')).not.toHaveAttribute('data-cell')
    expect(key('Alone')).not.toHaveAttribute('data-block')
  })

  it('draws the content blocks', () => {
    show(
      widget({
        widget: 'stack',
        children: [
          { widget: 'text', text: 'Heading', style: 'heading' },
          { widget: 'link', label: 'The PR', url: 'https://github.com' },
          {
            widget: 'table',
            columns: ['PR', { label: 'Time', align: 'right' }],
            rows: [
              [{ text: '#412', url: 'https://github.com/o/r/pull/412', icon: 'github' }, '42s'],
              [{ text: '', icon: 'linear' }, 6],
            ],
          },
          { widget: 'progress', label: 'Checks', value: 7, max: 9, tone: 'ok' },
          { widget: 'list', style: 'check', items: ['lint', { text: 'e2e', checked: true }] },
          { widget: 'list', style: 'number', items: [{ text: 'First', caption: 'why' }] },
          { widget: 'callout', title: 'Waiting', text: 'Two approvals', tone: 'warn' },
          { widget: 'code', code: 'let a = 1', language: 'ts', title: 'Snippet' },
          { widget: 'quote', text: 'ship it', cite: 'Noah' },
          { widget: 'avatar', name: 'Noah Kim', subtitle: 'Reviewer' },
          { widget: 'timeline', items: [{ title: 'Merged', time: '2h', tone: 'ok' }] },
        ],
      }),
    )
    expect(screen.getByText('Heading')).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByLabelText('GitHub')).toBeInTheDocument()
    expect(screen.getByLabelText('Linear')).toBeInTheDocument()
    expect(screen.getByText('78%')).toBeInTheDocument()
    expect(screen.getByText('e2e').closest('[data-done]')).not.toBeNull()
    expect(screen.getByText('why')).toBeInTheDocument()
    expect(screen.getByText('Waiting')).toBeInTheDocument()
    expect(screen.getByText('Snippet')).toBeInTheDocument()
    expect(screen.getByText('Noah')).toBeInTheDocument()
    expect(screen.getByText('NK')).toBeInTheDocument()
    expect(screen.getByText('Merged')).toBeInTheDocument()
    fireEvent.click(screen.getByText('The PR'))
    expect(openLink).toHaveBeenCalledWith('https://github.com', { target: 'split' })
    fireEvent.click(screen.getByText('#412'))
    expect(openLink).toHaveBeenCalledWith('https://github.com/o/r/pull/412', { target: 'split' })
  })

  it("draws relay://assistant/<id>/avatar as that assistant's own portrait, with no image fetch", () => {
    show(
      widget({
        widget: 'avatar',
        name: 'Nova',
        subtitle: 'Personal',
        src: 'relay://assistant/nova/avatar',
      }),
    )
    const portrait = screen.getByTestId('agent-portrait-nova')
    expect(portrait).toHaveClass('eva-wb-avatar-portrait')
    expect(portrait.querySelector('img')).not.toBeNull()
    expect(document.querySelector('img[src^="relay-media:"]')).toBeNull()
    expect(screen.getByText('Nova')).toBeInTheDocument()
  })

  it('sends a reply button as the next turn and opens a url button', () => {
    const reply = show(
      widget({
        widget: 'stack',
        direction: 'horizontal',
        children: [
          { widget: 'button', label: 'Nudge', reply: 'nudge Noah', variant: 'primary' },
          { widget: 'button', label: 'Open PR', url: 'https://github.com/o/r/pull/1' },
        ],
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Nudge' }))
    expect(reply).toHaveBeenCalledWith('nudge Noah')
    fireEvent.click(screen.getByRole('button', { name: 'Open PR' }))
    expect(openLink).toHaveBeenCalledWith('https://github.com/o/r/pull/1', { target: 'split' })
  })

  it('makes a whole card with a relay:// url one link', () => {
    show(
      widget({
        widget: 'card',
        title: 'Nova',
        url: 'relay://assistant/nova',
        children: [{ widget: 'text', text: 'Personal, Relay, Eva' }],
      }),
    )
    const card = screen.getByRole('link', { name: 'Nova' })
    fireEvent.click(screen.getByText('Personal, Relay, Eva'))
    expect(openLink).toHaveBeenLastCalledWith('relay://assistant/nova', { target: 'split' })
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(openLink).toHaveBeenLastCalledWith('relay://assistant/nova')
  })

  it('disables reply controls without a live session, but not links', () => {
    show(
      widget({
        widget: 'stack',
        children: [
          { widget: 'button', label: 'Nudge', reply: 'nudge' },
          { widget: 'button', label: 'Open', url: 'https://a.com' },
          { widget: 'input', placeholder: 'Name' },
        ],
      }),
      vi.fn(),
      false,
    )
    expect(screen.getByRole('button', { name: 'Nudge' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled()
    expect(screen.getByLabelText('Name')).toBeDisabled()
  })

  it('submits an input through its reply template, then says Sent', async () => {
    const user = userEvent.setup()
    const reply = show(
      widget({ widget: 'input', placeholder: 'New name', reply: 'rename to {value}' }),
    )
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    await user.type(screen.getByLabelText('New name'), '  Atlas {Enter}')
    expect(reply).toHaveBeenCalledWith('rename to Atlas')
    expect(screen.getByLabelText('New name')).toHaveValue('')
    expect(screen.getByTestId('widget-input-sent')).toHaveTextContent('Sent')
  })

  it('switches tabs and opens a collapse', async () => {
    const user = userEvent.setup()
    show(
      widget({
        widget: 'stack',
        children: [
          {
            widget: 'tabs',
            tabs: [
              { label: 'One', children: [{ widget: 'text', text: 'first pane' }] },
              { label: 'Two', children: [{ widget: 'text', text: 'second pane' }] },
            ],
          },
          { widget: 'collapse', title: 'More', children: [{ widget: 'text', text: 'hidden' }] },
          { widget: 'grid', columns: 3, children: [{ widget: 'badge', label: 'cell' }] },
        ],
      }),
    )
    expect(screen.getByText('first pane')).toBeInTheDocument()
    expect(screen.queryByText('second pane')).toBeNull()
    await user.click(screen.getByRole('tab', { name: 'Two' }))
    expect(screen.getByText('second pane')).toBeInTheDocument()
    const head = screen.getByRole('button', { name: 'More' })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    await user.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('cell')).toBeInTheDocument()
  })

  it('falls back to the warning code block when a widget throws while drawing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    show(widget({ widget: 'diagram', src: '/tmp/flow.png' }))
    expect(screen.getByText("Widget couldn't render")).toBeInTheDocument()
    expect(screen.queryByTestId('widget')).not.toBeNull()
  })
})
