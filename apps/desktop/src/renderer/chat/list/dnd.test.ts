import { describe, expect, it } from 'vitest'
import type { KeyboardCoordinateGetter } from '@dnd-kit/core'
import { folderKeyboardCoordinates, resolveDrop } from './dnd'

describe('resolveDrop', () => {
  it('a chat on another folder header moves into that folder', () => {
    expect(
      resolveDrop({ type: 'chat', id: 'a', group: 'Other' }, { type: 'group', name: 'Focus' }),
    ).toEqual({ kind: 'assign', id: 'a', group: 'Focus' })
  })
  it('a chat dropped on its own folder does nothing', () => {
    expect(
      resolveDrop({ type: 'chat', id: 'a', group: 'Other' }, { type: 'group', name: 'Other' }),
    ).toBeNull()
  })
  it('folders are not dragged, and no target gives null', () => {
    expect(
      resolveDrop({ type: 'group', name: 'Other' }, { type: 'group', name: 'Focus' }),
    ).toBeNull()
    expect(resolveDrop({ type: 'chat', id: 'a' }, null)).toBeNull()
  })
})

describe('folderKeyboardCoordinates', () => {
  type Args = Parameters<KeyboardCoordinateGetter>[1]
  const rect = (top: number, height: number) => ({
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 100,
    width: 100,
  })
  // Headers at 0, 100 and 300 (middles 10, 110, 310); the lifted row's middle sits at 150.
  const headers = [rect(0, 20), rect(100, 20), rect(300, 20)]
  const args = {
    active: 'chat:a',
    currentCoordinates: { x: 5, y: 140 },
    context: {
      collisionRect: rect(130, 40),
      droppableRects: new Map(headers.map((r, i) => [`group:${i}`, r])),
      droppableContainers: { getEnabled: () => headers.map((_, i) => ({ id: `group:${i}` })) },
    },
  } as unknown as Args
  const key = (code: string) => ({ code, preventDefault: () => {} }) as KeyboardEvent

  it('moves the middle onto the next header above or below', () => {
    expect(folderKeyboardCoordinates(key('ArrowUp'), args)).toEqual({ x: 5, y: 100 })
    expect(folderKeyboardCoordinates(key('ArrowDown'), args)).toEqual({ x: 5, y: 300 })
  })
  it('ignores other keys and the end of the list', () => {
    expect(folderKeyboardCoordinates(key('ArrowLeft'), args)).toBeUndefined()
    const top = { ...args, context: { ...args.context, collisionRect: rect(-10, 20) } } as Args
    expect(folderKeyboardCoordinates(key('ArrowUp'), top)).toBeUndefined()
  })
})
