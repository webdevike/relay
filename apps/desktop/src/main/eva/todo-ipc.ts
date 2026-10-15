import { nextTodoId } from '@evaos/eva-core/model/todos'
import { readTodoTexts } from '@evaos/eva-core/model/read-eva'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { clockFor, evaFsFor } from './runtime'
import { appendTodoVia, knownTags } from './todo-write'

function bad(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid-input' })
}

/** Handler body shared by IPC and tests; validates the tag and collapses line breaks. */
export async function addTodoHandler(
  ctx: Pick<MainContext, 'env'>,
  input: { tag: string; text: string },
): Promise<{ id: string; tag: string; row: string }> {
  const root = ctx.env.evaRoot
  if (!knownTags(root).has(input.tag)) throw bad(`Unknown workspace ${input.tag}.`)
  const text = input.text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  if (!text) throw bad('Todo text is empty.')
  return appendTodoVia(evaFsFor(ctx), root, input.tag, text, clockFor(ctx).today())
}

export function registerTodoIpc(ctx: MainContext): void {
  handle(ctx, 'eva.todo.preview', () => {
    const { todos, done } = readTodoTexts(ctx.env.evaRoot)
    return { nextId: nextTodoId(todos ?? '', done), today: clockFor(ctx).today() }
  })
  handle(ctx, 'eva.todo.add', (input) => addTodoHandler(ctx, input))
}
