import * as os from 'node:os'
import * as path from 'node:path'
import { GateStatusSchema, type GateStatus, type InvokeInput } from '@evaos/contract'
import { gateArgs, GateArgError, type GateAction } from '@evaos/eva-core/model/gate-args'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { openPathChecked } from './open-path'
import { issuePhotoToken, takePhotoToken } from './photo-tokens'
import { buildCommand, childPathFor, recordSpawn, runCapture, type Command } from './spawn'

export const GATE_TIMEOUT_MS = 15_000

type HabitRun = InvokeInput<'habit.run'>

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

export type CommandBuilder = (argv: string[]) => Promise<Command> | Command

/** Runs one habit-gate invocation; the whole stdout is one JSON document. */
export async function runGate(
  build: CommandBuilder,
  root: string,
  args: string[],
  onSpawn?: (cmd: Command) => void,
): Promise<GateStatus> {
  const cmd = await build([...args, '--json'])
  onSpawn?.(cmd)
  const res = await runCapture(cmd, root, GATE_TIMEOUT_MS)
  if (res.timedOut) throw coded('The habit gate timed out.', 'gate-error')
  let doc: unknown = null
  try {
    doc = JSON.parse(res.stdout)
  } catch {
    doc = null
  }
  const message = (doc as { error?: unknown } | null)?.error
  if (typeof message === 'string' && message !== '') throw coded(message, 'gate-error')
  if (res.code !== 0) {
    const last = res.stderr.trim().split('\n').pop() || 'no output'
    throw coded(`The habit gate failed: ${last}`, 'gate-error')
  }
  const parsed = GateStatusSchema.safeParse(doc)
  if (!parsed.success) throw coded('The habit gate returned an unreadable status.', 'gate-error')
  return parsed.data
}

export function toGateAction(input: HabitRun): GateAction {
  switch (input.action) {
    case 'done': {
      let photo: string | null = null
      if (input.photoToken !== null) {
        photo = takePhotoToken(input.photoToken)
        if (photo === null) throw coded('That photo is no longer available.', 'invalid-input')
      }
      return { action: 'done', id: input.id, photo }
    }
    default:
      return input
  }
}

export interface HabitService {
  status(): Promise<GateStatus>
  run(input: HabitRun): Promise<GateStatus>
}

export function createHabitService(
  build: CommandBuilder,
  root: string,
  onSpawn?: (cmd: Command) => void,
): HabitService {
  let inflight: { epoch: number; promise: Promise<GateStatus> } | null = null
  // A status read that began before a command must never be shared with a read after it.
  let epoch = 0
  return {
    status() {
      if (inflight && inflight.epoch === epoch) return inflight.promise
      const mine = epoch
      const promise: Promise<GateStatus> = runGate(
        build,
        root,
        gateArgs({ action: 'status' }),
        onSpawn,
      ).finally(() => {
        if (inflight?.promise === promise) inflight = null
      })
      inflight = { epoch: mine, promise }
      return promise
    },
    async run(input) {
      let args: string[]
      try {
        args = gateArgs(toGateAction(input))
      } catch (e) {
        if (e instanceof GateArgError) throw coded(e.message, 'invalid-input')
        throw e
      }
      epoch += 1
      const result = await runGate(build, root, args, onSpawn)
      epoch += 1
      return result
    },
  }
}

export const PHOTO_EXTENSIONS = ['png', 'jpg', 'jpeg', 'heic', 'gif', 'webp']

interface OpenDialog {
  showOpenDialog(
    win: never,
    options: Electron.OpenDialogOptions,
  ): Promise<{ canceled: boolean; filePaths: string[] }>
}

/** Native picker for a proof photo; the path never leaves main, only a single-use token. */
export async function choosePhoto(
  win: unknown,
  getDialog: () => Promise<OpenDialog> | OpenDialog = async () =>
    (await import('electron')).dialog as unknown as OpenDialog,
): Promise<{ token: string | null; name: string | null }> {
  const res = await (
    await getDialog()
  ).showOpenDialog(win as never, {
    title: 'Choose a proof photo',
    buttonLabel: 'Use photo',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: PHOTO_EXTENSIONS }],
  })
  const file = res.canceled ? undefined : res.filePaths[0]
  if (!file) return { token: null, name: null }
  return { token: issuePhotoToken(file), name: path.basename(file) }
}

export function registerHabitIpc(ctx: MainContext): void {
  const root = ctx.env.evaRoot
  const service = createHabitService(
    async (argv) => {
      const home = os.homedir()
      const pathEnv = await childPathFor(ctx.env.live, home)
      return buildCommand(ctx.env.habitGateBin, argv, {
        pathEnv,
        homedir: home,
        execPath: process.execPath,
        baseEnv: process.env,
      })
    },
    root,
    (cmd) =>
      recordSpawn(ctx.env.e2e, {
        kind: 'habit-gate',
        file: cmd.file,
        argv: cmd.argv,
        cwd: root,
        at: Date.now(),
      }),
  )
  handle(ctx, 'habit.status', () => service.status())
  handle(ctx, 'habit.run', (input) => service.run(input))
  // The dialog is read at call time so e2e can replace dialog.showOpenDialog.
  handle(ctx, 'habit.choosePhoto', () => choosePhoto(ctx.win))
  handle(ctx, 'habit.openPhoto', async ({ path }) => {
    await openPathChecked(ctx, path, { allowRoots: [ctx.env.habitPhotosDir] })
    return { opened: true as const }
  })
}
