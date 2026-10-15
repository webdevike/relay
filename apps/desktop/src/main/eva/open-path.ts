import * as fs from 'node:fs'
import * as path from 'node:path'
import { isInside } from '@evaos/eva-core/fs/allowlist'
import type { MainContext } from '../context'
import { registerTestHook } from '../test-hooks'

type Ctx = Pick<MainContext, 'env'>
export type Opener = (abs: string) => Promise<string>

export interface OpenPathOptions {
  /** Realpath containment roots; defaults to the Eva root. */
  allowRoots?: string[]
  requireExt?: string
  /** Allowed extensions without the dot, case-insensitive; anything else is refused. */
  allowExts?: string[]
  /** Injectable for tests; the default is electron's shell.openPath. */
  opener?: Opener
}

interface OpenPathHook {
  calls: Array<{ path: string }>
  failNext: boolean
}

const hook: OpenPathHook = { calls: [], failNext: false }
registerTestHook('openPath', hook)

function failed(message: string): Error {
  return Object.assign(new Error(message), { code: 'open-failed' })
}

async function defaultOpener(abs: string): Promise<string> {
  const { shell } = await import('electron')
  return shell.openPath(abs)
}

/**
 * The single gate for shell.openPath (research Pitfall 9): realpath, regular file, inside the
 * allowed roots. In e2e the call is recorded instead of launching another app.
 */
export async function openPathChecked(
  ctx: Ctx,
  abs: string,
  opts: OpenPathOptions = {},
): Promise<void> {
  let real: string
  try {
    real = await fs.promises.realpath(abs)
    if (!(await fs.promises.stat(real)).isFile()) throw new Error('not a file')
  } catch {
    throw failed(`Could not open ${abs}`)
  }
  if (opts.requireExt && path.extname(real).toLowerCase() !== opts.requireExt.toLowerCase()) {
    throw failed(`Could not open ${abs}`)
  }
  if (opts.allowExts) {
    const ext = path.extname(real).slice(1).toLowerCase()
    if (!opts.allowExts.some((e) => e.toLowerCase() === ext)) {
      throw failed(`Could not open ${abs}`)
    }
  }
  const roots = await Promise.all(
    (opts.allowRoots ?? [ctx.env.evaRoot]).map((r) => fs.promises.realpath(r).catch(() => r)),
  )
  if (!roots.some((r) => isInside(real, r))) throw failed(`Could not open ${abs}`)
  if (ctx.env.e2e) {
    if (hook.failNext) {
      hook.failNext = false
      throw failed(`Could not open ${abs}`)
    }
    hook.calls.push({ path: real })
    if (hook.calls.length > 50) hook.calls.shift()
    return
  }
  const error = await (opts.opener ?? defaultOpener)(real)
  if (error) throw failed(`Could not open ${abs}`)
}
