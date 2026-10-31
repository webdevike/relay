import { describe, expect, it } from 'vitest'
import { linearBody } from './LinearDetail'

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
