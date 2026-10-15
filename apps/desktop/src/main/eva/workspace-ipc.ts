import * as path from 'node:path'
import type { WorkspaceDetail } from '@evaos/contract'
import { readWorkspaceDetail, workspaceFiles } from '@evaos/eva-core/model/read-eva'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { openPathChecked, type Opener } from './open-path'
import { clockFor } from './runtime'

type Ctx = Pick<MainContext, 'env'>

export function workspaceHandler(
  root: string,
  id: string,
  clock: { today(): string },
): WorkspaceDetail {
  return readWorkspaceDetail(root, id, clock.today()) as WorkspaceDetail
}

/** The id is resolved to a path here, never taken from the renderer (T-03-39). */
export async function openWorkspaceFile(
  ctx: Ctx,
  id: string,
  opener?: Opener,
): Promise<{ opened: true }> {
  const file = workspaceFiles(ctx.env.evaRoot).find((f) => f.id === id)
  if (!file || !file.path) {
    throw Object.assign(new Error('No file for this workspace'), { code: 'no-file' })
  }
  await openPathChecked(ctx, path.join(ctx.env.evaRoot, file.path), { opener })
  return { opened: true }
}

export function registerWorkspaceIpc(ctx: MainContext): void {
  handle(ctx, 'eva.workspace', ({ id }) => workspaceHandler(ctx.env.evaRoot, id, clockFor(ctx)))
  handle(ctx, 'eva.workspace.openFile', ({ id }) => openWorkspaceFile(ctx, id))
}
