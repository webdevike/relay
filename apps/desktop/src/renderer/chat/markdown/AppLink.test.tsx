import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { Markdown } from './Markdown'
import { splitAppLinks } from './remark-app-links'

const { openLink } = vi.hoisted(() => ({ openLink: vi.fn() }))
vi.mock('../../ipc', () => ({ invoke: vi.fn(), on: vi.fn() }))
vi.mock('../widgets/rich/model-scene', () => ({ mountModel: vi.fn() }))
vi.mock('../../navigation/open-link', () => ({ openLink }))

const show = (text: string) =>
  render(
    <MantineProvider>
      <Markdown text={text} />
    </MantineProvider>,
  )

describe('relay:// links in a reply', () => {
  it('render as in-app buttons, linked or bare, and open the place on click', () => {
    show(
      'Open [Connect GitHub](relay://open/settings/connections?connect=github), then relay://open/settings/theme?setting=theme.mode. Code stays: `relay://open/jobs`',
    )
    const links = screen.getAllByTestId('app-link')
    expect(links.map((a) => a.textContent)).toEqual([
      'Connect GitHub',
      'Settings › Theme › Appearance',
    ])
    expect(links[1]!.getAttribute('href')).toBe('relay://open/settings/theme?setting=theme.mode')
    expect(screen.getByText('relay://open/jobs').tagName).toBe('CODE')
    fireEvent.click(links[0]!)
    expect(openLink).toHaveBeenCalledWith('relay://open/settings/connections?connect=github', {
      target: 'split',
    })
    fireEvent.click(links[1]!, { altKey: true })
    expect(openLink).toHaveBeenLastCalledWith('relay://open/settings/theme?setting=theme.mode', {
      target: 'here',
    })
  })

  it('leaves text without a valid relay link alone', () => {
    expect(splitAppLinks('nothing here')).toBeNull()
    expect(splitAppLinks('bad relay://nope/x')).toBeNull()
    expect(splitAppLinks('see relay://open/jobs.')).toEqual([
      { type: 'text', value: 'see ' },
      {
        type: 'link',
        url: 'relay://open/jobs',
        children: [{ type: 'text', value: 'relay://open/jobs' }],
      },
      { type: 'text', value: '.' },
    ])
  })
})
