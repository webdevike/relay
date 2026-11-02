import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { Markdown } from '../chat/markdown/Markdown'
import { linearDisplay } from './LinearDetail'

describe('Linear mentions in Reviews', () => {
  it('render as a mention, not a link', () => {
    const people = [
      { name: 'Noah Champoux', handle: 'noah', url: 'https://linear.app/ws/profiles/noah' },
    ]
    const { container } = render(
      <MantineProvider>
        <Markdown text={linearDisplay('https://linear.app/ws/profiles/noah Sounds good', people)} />
      </MantineProvider>,
    )
    const mention = container.querySelector('.eva-md-mention')
    expect(mention?.textContent).toBe('@Noah Champoux')
    expect(mention?.getAttribute('data-color')).toBe('linear')
    expect(container.querySelector('a')).toBeNull()
  })
})
