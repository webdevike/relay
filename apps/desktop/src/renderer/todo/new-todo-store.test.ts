import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({
  invoke: vi.fn(async () => ({ ok: true, value: {} })),
  on: () => () => {},
}))

import { runAction } from '../hotkeys/router'
import { addOverlay, removeOverlay } from '../overlay/overlay-store'
import {
  finishNewTodo,
  newTodoStore,
  openNewTodo,
  resetNewTodoForTests,
  startNewTodo,
} from './new-todo-store'

describe('new todo store', () => {
  let stop: () => void = () => {}
  beforeEach(() => {
    resetNewTodoForTests()
    stop()
    stop = startNewTodo()
  })

  it('opens with eva by default, explicit tag wins, last used is remembered', () => {
    runAction('new-todo')
    expect(newTodoStore.getState()).toMatchObject({ opened: true, tag: 'eva' })
    openNewTodo({ tag: 'relay' })
    expect(newTodoStore.getState().tag).toBe('relay')
    finishNewTodo('relay')
    expect(newTodoStore.getState().opened).toBe(false)
    openNewTodo()
    expect(newTodoStore.getState().tag).toBe('relay')
  })

  it('is ignored while another overlay is open', () => {
    addOverlay('x')
    runAction('new-todo')
    expect(newTodoStore.getState().opened).toBe(false)
    removeOverlay('x')
  })
})
