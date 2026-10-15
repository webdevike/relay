import { describe, expect, it } from 'vitest'
import { resolveDrop } from './dnd'

const shown = ['Focus', 'Relay', 'Other']

describe('resolveDrop', () => {
  it('a chat on a header is assigned to that group', () => {
    expect(resolveDrop({ type: 'chat', id: 'a' }, { type: 'group', name: 'Focus' }, shown)).toEqual(
      { kind: 'assign', id: 'a', group: 'Focus' },
    )
  })
  it('a chat on a chat in another group joins that group', () => {
    expect(
      resolveDrop(
        { type: 'chat', id: 'a', group: 'Other' },
        { type: 'chat', id: 'b', group: 'Relay' },
        shown,
      ),
    ).toEqual({ kind: 'assign', id: 'a', group: 'Relay' })
  })
  it('a chat dropped back into its own group does nothing', () => {
    expect(
      resolveDrop(
        { type: 'chat', id: 'a', group: 'Other' },
        { type: 'chat', id: 'b', group: 'Other' },
        shown,
      ),
    ).toBeNull()
  })
  it('a header on a header reorders', () => {
    expect(
      resolveDrop({ type: 'group', name: 'Other' }, { type: 'group', name: 'Focus' }, shown),
    ).toEqual({ kind: 'reorder', moving: 'Other', target: 'Focus' })
  })
  it('a header on itself or on an unknown group does nothing', () => {
    expect(
      resolveDrop({ type: 'group', name: 'Focus' }, { type: 'group', name: 'Focus' }, shown),
    ).toBeNull()
    expect(
      resolveDrop({ type: 'group', name: 'Focus' }, { type: 'group', name: 'Nope' }, shown),
    ).toBeNull()
  })
  it('a header on a chat reorders against that chat group', () => {
    expect(
      resolveDrop(
        { type: 'group', name: 'Other' },
        { type: 'chat', id: 'b', group: 'Relay' },
        shown,
      ),
    ).toEqual({ kind: 'reorder', moving: 'Other', target: 'Relay' })
  })
  it('no target gives null', () => {
    expect(resolveDrop({ type: 'chat', id: 'a' }, null, shown)).toBeNull()
  })
})
