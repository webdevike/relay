import * as path from 'node:path'
import { z } from 'zod'
import { emit, handle } from '../ipc/handle'
import type { MainContext } from '../context'
import { readTail } from '../assistants/assistants'
import { apiKey } from '../linear/linear-ipc'
import { readJevKey } from './jev'
import { instructions, runAgent, shotsWanted, TOOLS } from './agent'
import { computerModels, OpenAIBrain, readOpenAIKey } from './brain'
import { PLAN_TOOL, planContext, planInstructions, planRun, reportRequest } from './brief'
import { Desktop } from './desktop'
import { connectDriver, driverBinary } from './driver'
import { JevJudge, ModelJudge } from './judge'
import { ModelLocator } from './locate'
import { assistBinary, startPresenter, type Presenter } from './presenter'
import { loadAssistants, loadEcardRepos, routeTask } from './route'
import { ComputerRuns, fileRowStore, type RunSpec } from './runs'
import { runWalk } from './walk'

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

/** How much of a session file the brief reads (its last turns), and each poll for the plan. */
const CHAT_TAIL_BYTES = 2_000_000
const PLAN_TAIL_BYTES = 400_000

/**
 * `@computer` (SPEC.md): the runs controller behind `chat.send`, and `computer.rows` for the chat.
 * Answers the intercept `chat.send` calls before routing a message to omp.
 */
export function registerComputer(
  ctx: MainContext,
  deps: {
    fileOf: (paneId: string) => string | null
    chatAgentOf: (file: string | null) => string | null
    /**
     * Words into assistant `agent`'s own thread through Relay, as a background line. With `ifIdle`
     * it sends nothing while the thread is mid-reply or waiting on Isaac. True when sent.
     */
    assistantTurn: (agent: string, text: string, opts: { ifIdle: boolean }) => Promise<boolean>
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
    const models = computerModels(ctx.config.readJson<unknown>('computer.json', null))
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
      const locator = new ModelLocator(key, models.step)
      const { route } = spec
      const assistant = { id: route.assistant.id, title: route.assistant.title }
      presenter?.assistant(assistant.id)
      presenter?.caption(`${assistant.title} is planning…`)
      const windows = (await desktop.windows().catch(() => []))
        .map((w) => `${w.app}: ${w.title}`)
        .join('\n')
      const file = spec.file
      const plan = await planRun({
        runId: spec.id,
        task: spec.task,
        mode: spec.mode,
        assistant: { title: assistant.title, profile: route.assistant.profile },
        own:
          spec.ownThread && file !== null
            ? {
                ask: (text) => deps.assistantTurn(assistant.id, text, { ifIdle: true }),
                read: () => readTail(file, PLAN_TAIL_BYTES),
              }
            : null,
        chat: file === null ? null : readTail(file, CHAT_TAIL_BYTES),
        planner: new OpenAIBrain(
          key,
          planInstructions({
            assistant: assistant.title,
            profile: route.assistant.profile,
            mode: spec.mode,
            today: today(),
          }),
          [PLAN_TOOL],
          models.plan,
        ),
        windows,
        ticket: await ticketFor(spec.task, ctx),
        signal: io.signal,
        log,
      }).catch((e: unknown) => {
        log(`${spec.id}: no plan: ${e instanceof Error ? e.message : String(e)}`)
        return null
      })
      if (plan) {
        io.plan(plan)
        log(`${spec.id}: plan by ${plan.by}: ${plan.brief.replace(/\s+/g, ' ').slice(0, 300)}`)
      }
      if (io.signal.aborted) return { outcome: 'stopped', summary: 'Stopped.', image: null }
      if (spec.mode === 'walk' && presenter) {
        if (!plan) {
          presenter.hide()
          return { outcome: 'failed', summary: "I couldn't plan the steps.", image: null }
        }
        const jevKey = readJevKey(ctx.env.evaRoot)
        return await runWalk({
          plan,
          assistant,
          desktop,
          judge: jevKey ? new JevJudge(jevKey) : new ModelJudge(key, models.step),
          locator,
          presenter,
          io,
          control,
        })
      }
      return await runAgent({
        task: spec.task,
        mode: spec.mode === 'live' ? 'live' : 'headless',
        assistant,
        desktop,
        locator,
        brain: new OpenAIBrain(
          key,
          instructions({
            assistant: assistant.title,
            mode: spec.mode,
            today: today(),
            ...(plan ? { context: planContext(plan, assistant.title) } : {}),
          }),
          TOOLS,
          models.step,
        ),
        presenter,
        io,
        plan,
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
    report: (spec, result, lines, pictures) =>
      deps.assistantTurn(
        spec.route.assistant.id,
        reportRequest({
          assistant: spec.route.assistant.title,
          task: spec.task,
          result,
          lines,
          pictures,
        }),
        { ifIdle: false },
      ),
    log,
  })
  handle(ctx, 'computer.rows', ({ paneId, file }) => ({ rows: runs.rowsFor(paneId, file) }))
  ctx.onBeforeQuit(async () => runs.stopAll())
  return runs
}
