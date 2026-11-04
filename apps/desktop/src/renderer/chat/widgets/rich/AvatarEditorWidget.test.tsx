import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { parseSaveMessage, partValue, type Portrait } from '@relay/portrait-motion'
import type { ChatMessage } from '@evaos/chat-core/message'
import { OpenUIBlock } from '../Widget'
import { WidgetActions, WidgetScope } from '../actions'
import { openAvatarEditor, useLocalRows } from '../../local-rows'
import { setAgentTitles } from '../../../eva/names-store'

// The painter draws SVG per animation frame; here only what the editor tells it matters.
vi.mock('../../../assistants/AvatarPreview', () => ({
  AvatarPreview: ({ portrait, face }: { portrait: { style: string }; face: string }) => (
    <div data-testid="avatar-editor-preview" data-style={portrait.style} data-face={face} />
  ),
}))

const NOVA = {
  style: 'micah',
  seed: 'nova-17',
  options: { hair: ['pixie'], glassesProbability: 0 },
  colors: { paper: '#e7f5ff', accent: '#1c7ed6' },
}
const PROGRAM = `root = AvatarEditor("nova", ${JSON.stringify(NOVA).replace(/"(\w+)":/g, '$1:')})`

function show(opts: { canReply?: boolean; scope?: string | null } = {}) {
  const reply = vi.fn()
  render(
    <MantineProvider>
      <WidgetActions.Provider value={{ reply, canReply: opts.canReply ?? true }}>
        <WidgetScope.Provider value={opts.scope ?? null}>
          <OpenUIBlock code={PROGRAM} closed />
        </WidgetScope.Provider>
      </WidgetActions.Provider>
    </MantineProvider>,
  )
  return reply
}

const saved = (reply: Mock) => {
  expect(reply).toHaveBeenCalledTimes(1)
  const sent = parseSaveMessage(reply.mock.calls[0]![0] as string)
  expect(sent).not.toBeNull()
  return sent!
}

beforeEach(() => {
  setAgentTitles({ nova: 'Nova' })
})

describe('AvatarEditor widget', () => {
  it('parses from an openui fence and starts from the agent current avatar', () => {
    show()
    const root = screen.getByTestId('avatar-editor')
    expect(root).toHaveAttribute('data-agent', 'nova')
    expect(screen.getByText("Nova's avatar")).toBeInTheDocument()
    expect(screen.getByTestId('avatar-editor-preview')).toHaveAttribute('data-style', 'micah')
    expect(screen.getByTestId('avatar-editor-part-value')).toHaveTextContent('Hair: pixie')
  })

  it('keeps Save off until something changes, and Save sends the structured message once', async () => {
    const user = userEvent.setup()
    const reply = show()
    const save = screen.getByTestId('avatar-editor-save')
    expect(save).toBeDisabled()

    await user.click(screen.getByTestId('avatar-editor-shuffle'))
    expect(save).toBeEnabled()
    await user.click(save)

    const { agent, avatar } = saved(reply)
    expect(agent).toBe('nova')
    expect(avatar.style).toBe('micah')
    expect(avatar.seed).toBe('nova-17')
    expect(avatar.colors).toEqual(NOVA.colors)
    expect(reply.mock.calls[0]![0]).toMatch(/^Save my avatar: \{"agent":"nova","avatar":\{/)
    expect(screen.getByTestId('avatar-editor-sent')).toHaveTextContent('Sent to Nova')
    expect(screen.getByTestId('avatar-editor-save')).toBeDisabled()
  })

  it('picks a variant of the open part from its thumbnails', async () => {
    const user = userEvent.setup()
    const reply = show()
    const thumbs = within(screen.getByTestId('avatar-editor-thumbs'))
    await user.click(thumbs.getByRole('option', { name: 'Hair mrClean' }))
    expect(screen.getByTestId('avatar-editor-part-value')).toHaveTextContent('Hair: mrClean')

    await user.click(screen.getByTestId('avatar-editor-save'))
    expect(partValue(saved(reply).avatar, 'hair')).toBe('mrClean')
  })

  it('switches parts, turns an optional part on and off, and colors', async () => {
    const user = userEvent.setup()
    const reply = show()
    await user.click(screen.getByTestId('avatar-editor-part-glasses'))
    expect(screen.getByTestId('avatar-editor-part-value')).toHaveTextContent('Glasses: none')
    await user.click(
      within(screen.getByTestId('avatar-editor-thumbs')).getByRole('option', {
        name: 'Glasses round',
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Background #ffe3e3' }))
    await user.click(screen.getByRole('button', { name: 'Accent #d6336c' }))
    await user.click(screen.getByRole('button', { name: 'Hair color #fc909f' }))
    await user.click(screen.getByTestId('avatar-editor-save'))

    const { avatar } = saved(reply)
    expect(partValue(avatar, 'glasses')).toBe('round')
    expect(avatar.colors).toEqual({ paper: '#ffe3e3', accent: '#d6336c' })
    expect(avatar.options?.['hairColor']).toEqual(['fc909f'])
  })

  it('switches style and the preview face', async () => {
    const user = userEvent.setup()
    const reply = show()
    await user.click(screen.getByRole('radio', { name: 'Talking' }))
    expect(screen.getByTestId('avatar-editor-preview')).toHaveAttribute('data-face', 'talking')
    await user.click(screen.getByRole('radio', { name: 'Notionists' }))
    expect(screen.getByTestId('avatar-editor-preview')).toHaveAttribute('data-style', 'notionists')
    expect(screen.queryByRole('button', { name: /Hair color/ })).toBeNull()

    await user.click(screen.getByTestId('avatar-editor-save'))
    expect(saved(reply).avatar.style).toBe('notionists')
  })

  it('cannot save where nothing can be sent', async () => {
    const user = userEvent.setup()
    show({ canReply: false })
    await user.click(screen.getByTestId('avatar-editor-shuffle'))
    expect(screen.getByTestId('avatar-editor-save')).toBeDisabled()
  })
})

describe('the avatar editor row the header posts', () => {
  function Rows() {
    return (
      <span data-testid="rows">
        {useLocalRows('pane-1')
          .map((r) => r.id)
          .join(',')}
      </span>
    )
  }

  it('is an assistant reply holding the editor fence, one per pane, gone on Cancel', async () => {
    const user = userEvent.setup()
    openAvatarEditor('pane-1', 'nova', NOVA as Portrait)
    openAvatarEditor('pane-1', 'nova', NOVA as Portrait)
    let row: ChatMessage | undefined
    function Probe() {
      row = useLocalRows('pane-1')[0]
      return null
    }
    render(
      <MantineProvider>
        <Probe />
        <Rows />
        <WidgetActions.Provider value={{ reply: vi.fn(), canReply: true }}>
          <WidgetScope.Provider value="local:avatar-editor:1">
            <OpenUIBlock code={PROGRAM} closed />
          </WidgetScope.Provider>
        </WidgetActions.Provider>
      </MantineProvider>,
    )
    expect(row?.role).toBe('assistant')
    expect(row?.text.startsWith('```openui\nroot = AvatarEditor("nova"')).toBe(true)
    expect(screen.getByTestId('rows').textContent).toBe('local:avatar-editor:1')
    await user.click(screen.getByTestId('avatar-editor-cancel'))
    expect(screen.getByTestId('rows').textContent).toBe('')
  })
})
