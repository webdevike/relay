import { describe, expect, it } from 'vitest'
import { linearBody, linearDisplay } from './LinearDetail'

const P = (name: string, handle: string) => ({
  name,
  handle,
  url: `https://linear.app/ws/profiles/${handle}`,
})

describe('linearBody', () => {
  it('turns @Name into the profile link Linear mentions with, longest name first', () => {
    const people = [P('Ann', 'ann'), P('Ann Lee', 'alee')]
    expect(linearBody('@Ann Lee and @Ann, see @Annex', people)).toBe(
      'https://linear.app/ws/profiles/alee and https://linear.app/ws/profiles/ann, see @Annex',
    )
    expect(linearBody('@Astra hi', [{ name: 'Astra', handle: 'Astra', url: '' }])).toBe('@Astra hi')
  })
})

describe('linearDisplay', () => {
  it('shows profile links as @Name mentions, falling back to the handle', () => {
    const people = [
      { name: 'Noah Champoux', handle: 'noah', url: 'https://linear.app/ws/profiles/noah' },
    ]
    expect(
      linearDisplay(
        'https://linear.app/ecard-systems/profiles/noah Sounds good, <https://linear.app/ws/profiles/sarms>?',
        people,
      ),
    ).toBe('[@Noah Champoux](mention:linear) Sounds good, [@sarms](mention:linear)?')
    // A link someone wrote by hand keeps its text.
    expect(linearDisplay('[Noah](https://linear.app/ws/profiles/noah)', people)).toBe(
      '[Noah](https://linear.app/ws/profiles/noah)',
    )
  })
})
