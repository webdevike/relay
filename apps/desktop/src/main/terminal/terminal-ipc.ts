import * as os from 'node:os'
import * as pty from 'node-pty'
import { z } from 'zod'
import type { ChatHandles } from '../chat'
import type { MainContext } from '../context'
import { buildCommand, childPathFor, runCapture } from '../eva/spawn'
import { emit, handle } from '../ipc/handle'
import { createTerminalService } from './terminal-service'

/** `herdr agent list` answers at once; this only guards a hung CLI. */
const LIST_TIMEOUT_MS = 8000

const AgentsSchema = z.object({
  result: z.object({
    agents: z.array(
      z.object({
        pane_id: z.string().min(1),
        agent_session: z.object({ value: z.string() }).optional(),
      }),
    ),
  }),
})

/** The Terminal tool: ptys for shells and for a chat's herdr session; the renderer only names the chat. */
export function registerTerminalIpc(ctx: MainContext, chat: Pick<ChatHandles, 'placeOf'>): void {
  const home = os.homedir()
  const herdrBin = ctx.env.herdrBin
  let pathEnv: Promise<string> | null = null
  const path = (): Promise<string> => (pathEnv ??= childPathFor(ctx.env.live, home))

  const service = createTerminalService({
    evaRoot: ctx.env.evaRoot,
    homedir: home,
    shell: process.env['SHELL'] || '/bin/zsh',
    herdrBin,
    placeOf: (file) => {
      try {
        return chat.placeOf(file)
      } catch {
        return null
      }
    },
    env: async () => ({ ...process.env, PATH: await path() }),
    paneOf: async (file) => {
      if (herdrBin === null) return null
      const cmd = buildCommand(herdrBin, ['agent', 'list'], {
        pathEnv: await path(),
        homedir: home,
        execPath: process.execPath,
        baseEnv: process.env,
      })
      const out = await runCapture(cmd, ctx.env.evaRoot, LIST_TIMEOUT_MS)
      if (out.code !== 0) return null
      let json: unknown
      try {
        json = JSON.parse(out.stdout)
      } catch {
        return null
      }
      const parsed = AgentsSchema.safeParse(json)
      if (!parsed.success) return null
      return parsed.data.result.agents.find((a) => a.agent_session?.value === file)?.pane_id ?? null
    },
    spawn: (p) =>
      pty.spawn(p.file, p.argv, {
        name: 'xterm-256color',
        cwd: p.cwd,
        env: p.env as Record<string, string>,
        cols: p.cols,
        rows: p.rows,
      }),
    emitData: (id, data) => emit(ctx, 'terminal.data', { id, data }),
    emitExit: (id, code) => emit(ctx, 'terminal.exit', { id, code }),
  })

  handle(ctx, 'terminal.spawn', (input) => service.spawn(input))
  handle(ctx, 'terminal.write', ({ id, data }) => {
    service.write(id, data)
    return {}
  })
  handle(ctx, 'terminal.resize', ({ id, cols, rows }) => {
    service.resize(id, cols, rows)
    return {}
  })
  handle(ctx, 'terminal.kill', ({ id }) => {
    service.kill(id)
    return {}
  })
  handle(ctx, 'terminal.attachable', async ({ file }) => ({ pane: await service.attachable(file) }))
  ctx.onBeforeQuit(async () => service.close())
}
