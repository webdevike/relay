import * as path from 'node:path'
import { z } from 'zod'
import { emit, handle } from '../ipc/handle'
import type { MainContext } from '../context'
import { apiKey } from '../linear/linear-ipc'
import { readJevKey } from '../rooms/jev'
import { instructions, runAgent, shotsWanted, TOOLS } from './agent'
import { OpenAIBrain, readOpenAIKey } from './brain'
import { Desktop } from './desktop'
import { connectDriver, driverBinary } from './driver'
import { JevJudge, ModelJudge } from './judge'
import { assistBinary, startPresenter, type Presenter } from './presenter'
import { loadAssistants, loadEcardRepos, routeTask } from './route'
import { ComputerRuns, fileRowStore, type RunSpec } from './runs'
import { PLAN_TOOL, planInstructions, runWalk } from './walk'

const IssueSchema = z.object({
  data: z
    .object({
      issue: z
        .object({ identifier: z.string(), title: z.string(), description: z.string().nullable() })
        .nullable(),
    })
    .nullable()
    .optional(),
})

/** The ticket a walkthrough names (`ENG-6810`), read-only from Linear; null when none or unreadable. */
async function ticketFor(task: string, ctx: MainContext): Promise<string | null> {
  const key = /\b[A-Z][A-Z0-9]*-\d+\b/.exec(task)?.[0]
  if (!key) return null
  const token = await apiKey(ctx.env.evaRoot, ctx.env.configDir)
  if (!token) return null
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify({
      query: 'query($id: String!) { issue(id: $id) { identifier title description } }',
      variables: { id: key },
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!res?.ok) return null
  const issue = IssueSchema.safeParse(await res.json()).data?.data?.issue
  return issue
    ? `${issue.identifier} ${issue.title}\n\n${(issue.description ?? '').slice(0, 6000)}`
    : null
}

const today = (): string => new Date().toDateString()

/**
 * `@computer` (SPEC.md): the runs controller behind `chat.send`, and `computer.rows` for the chat.
 * Answers the intercept `chat.send` calls before routing a message to omp.
 */
export function registerComputer(
  ctx: MainContext,
  deps: {
    fileOf: (paneId: string) => string | null
    chatAgentOf: (file: string | null) => string | null
    remote: boolean
  },
): ComputerRuns {
  const log = (line: string): void => console.info(`[computer] ${line}`)
  const resources = process.resourcesPath ?? null

  const launch: ConstructorParameters<typeof ComputerRuns>[0]['launch'] = async (
    spec: RunSpec,
    io,
    control,
  ) => {
    const key = readOpenAIKey(ctx.env.evaRoot)
    if (!key) throw new Error('no OpenAI key (OPENAI_API_KEY or secrets/openai.env)')
    const bin = driverBinary()
    if (!bin) throw new Error('cua-driver is not installed (CuaDriver.app)')
    const driver = await connectDriver(bin)
    log(`${spec.id}: cua-driver ${driver.backend}`)
    let presenter: Presenter | null = null
    try {
      if (spec.mode !== 'headless') {
        const assist = assistBinary(resources)
        if (!assist)
          throw new Error(
            'Relay Assist is not in this build, so live and walk cannot show a cursor',
          )
        presenter = await startPresenter(assist, log)
        presenter.onEsc(() => io.stop())
      }
      const desktop = new Desktop(driver)
      const assistant = { id: spec.route.assistant.id, title: spec.route.assistant.title }
      if (spec.mode === 'walk' && presenter) {
        const jevKey = readJevKey(ctx.env.evaRoot)
        return await runWalk({
          task: spec.task,
          assistant,
          desktop,
          planner: new OpenAIBrain(key, planInstructions(assistant.title, today()), [PLAN_TOOL]),
          judge: jevKey ? new JevJudge(jevKey) : new ModelJudge(key),
          presenter,
          io,
          control,
          ticket: await ticketFor(spec.task, ctx),
        })
      }
      return await runAgent({
        task: spec.task,
        mode: spec.mode === 'live' ? 'live' : 'headless',
        assistant,
        desktop,
        brain: new OpenAIBrain(
          key,
          instructions({ assistant: assistant.title, mode: spec.mode, today: today() }),
          TOOLS,
        ),
        presenter,
        io,
        shots: {
          dir: path.join(ctx.env.configDir, 'computer', spec.id),
          want: shotsWanted(spec.task),
        },
      })
    } finally {
      presenter?.close()
      driver.close()
    }
  }

  const runs = new ComputerRuns({
    emit: (paneId, file, rows) => emit(ctx, 'computer.rows', { paneId, file, rows }),
    fileOf: deps.fileOf,
    chatAgentOf: deps.chatAgentOf,
    route: (task, chatAgent) =>
      routeTask(task, loadAssistants(ctx.env.evaRoot), chatAgent, loadEcardRepos()),
    launch,
    remote: deps.remote,
    store: fileRowStore(path.join(ctx.env.configDir, 'computer', 'threads')),
    log,
  })
  handle(ctx, 'computer.rows', ({ paneId, file }) => ({ rows: runs.rowsFor(paneId, file) }))
  ctx.onBeforeQuit(async () => runs.stopAll())
  return runs
}
