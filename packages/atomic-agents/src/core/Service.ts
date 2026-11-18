import { Effect, FileSystem, Option, Path, type PlatformError, Schedule, Schema } from "effect"
import { exec } from "./exec.ts"
import { Home } from "./Event.ts"
import { ConfigModes, probeSource, RosterRows, rosterLosses, sourceRefusals } from "./InstallGate.ts"

/**
 * `serve` as its own macOS LaunchAgent (Eva's `ai.eva.*` family): KeepAlive, logs under the home dir.
 * It runs an installed copy in `<home>/app/atomic-agents`, never a checkout, so removing a worktree cannot break it.
 */
export const LABEL = "ai.eva.atomic-agents"
const PACKAGE = new URL("../..", import.meta.url).pathname
const BLENDER_APP = "/Applications/Blender.app/Contents/MacOS/Blender"

export class ServiceError extends Schema.TaggedError<ServiceError>()("ServiceError", {
  message: Schema.String
}) {}

/** File work the installer cannot do is a `ServiceError` naming the step. */
const step = (what: string) => Effect.mapError((error: PlatformError.PlatformError) => new ServiceError({ message: `${what}: ${error.message}` }))

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const paths = Effect.gen(function*() {
  const path = yield* Path.Path
  const home = yield* Home
  const user = Bun.env["HOME"] ?? ""
  return {
    plist: path.join(user, "Library", "LaunchAgents", `${LABEL}.plist`),
    log: path.join(home.root, "logs", "serve.log"),
    app: path.join(home.root, "app"),
    root: home.root,
    user,
    target: `gui/${process.getuid?.() ?? 501}`
  }
})

const launchctl = (...args: ReadonlyArray<string>) =>
  exec("launchctl", args).pipe(step("launchctl"))

/** What a replacement install of `<home>/app` reads of the copy it replaces. */
const InstallSource = Schema.Struct({ commit: Schema.optionalKey(Schema.String) })
const decodeInstallSource = Schema.decodeUnknownOption(Schema.fromJsonString(InstallSource))
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigModes))
const decodeRoster = Schema.decodeUnknownEffect(Schema.fromJsonString(RosterRows))

export interface InstallOptions {
  /** Install even when a gate refuses (the reasons are still printed). */
  readonly force: boolean
  /** `<remote>/<branch>` the source must be on. */
  readonly base: string
}

/**
 * Install or replace the service. Run from a checkout, it builds the replacement first and swaps it in only once it
 * is ready and the gates pass (`InstallGate.ts`):
 * 1. stage: copy this package (src, the domains with the built-in agents, package.json, bun.lock) into
 *    `<home>/app.next/atomic-agents` and the chat-core sources it depends on (`file:../chat-core`, Relay's widget
 *    parser) into `<home>/app.next/chat-core`, side by side as in the repo; install production dependencies there and
 *    make bun's absolute links into the stage relative, so the tree still resolves once renamed;
 * 2. gate: the source must be a clean checkout on `base` that contains the installed commit, and the staged copy's
 *    roster (`list --json`) must load every agent the installed copy loads and every agent config.json sets to
 *    live or shadow; otherwise it refuses with every reason and leaves the running service alone, unless `force`;
 * 3. swap: stop the service, rename `<home>/app` to `<home>/app.prev` (kept until the next install, for a manual
 *    rollback) and the stage to `<home>/app`, write the plist and start it; a start that fails puts `app.prev` back.
 * Run from the installed copy it only reloads. Blender runs `-b` only, so the service never takes focus. A copy from a
 * git checkout also writes `<home>/app/source.json` (`gitDir`, `package`, `commit`, `installedAt`): where an edit
 * made in the installed copy is committed back, and what the next install checks against.
 */
export const install = (options: InstallOptions) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { plist, log, app, root, user, target } = yield* paths
  const blender = Bun.env["BLENDER"] ?? ((yield* fs.exists(BLENDER_APP).pipe(Effect.orElseSucceed(() => false))) ? BLENDER_APP : "blender")
  const env: Record<string, string> = {
    HOME: user,
    PATH: [path.dirname(process.execPath), path.join(user, ".local", "bin"), "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    ATOMIC_AGENTS_HOME: root,
    BLENDER: blender,
    // The omp profile model calls run under; launchd has none, and omp's default profile may load unrelated MCP servers.
    ...(Bun.env["OMP_PROFILE"] ? { OMP_PROFILE: Bun.env["OMP_PROFILE"] } : {})
  }
  const installed = path.join(app, "atomic-agents")
  const cli = path.join(installed, "src", "cli.ts")
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(process.execPath)}</string>
		<string>${xml(cli)}</string>
		<string>serve</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${Object.entries(env).map(([key, value]) => `\t\t<key>${key}</key><string>${xml(value)}</string>`).join("\n")}
	</dict>
	<key>WorkingDirectory</key><string>${xml(root)}</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>30</integer>
	<key>StandardOutPath</key><string>${xml(log)}</string>
	<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
  yield* fs.makeDirectory(path.dirname(log), { recursive: true }).pipe(step("create log dir"))
  yield* fs.makeDirectory(path.dirname(plist), { recursive: true }).pipe(step("create LaunchAgents dir"))
  // bootout is asynchronous; bootstrap fails with EIO until the old instance is gone.
  const start = launchctl("bootstrap", target, plist).pipe(
    Effect.flatMap((result) => result.exitCode === 0 ? Effect.void : Effect.fail(new ServiceError({ message: result.stderr.trim() }))),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 })
  )
  const source = yield* fs.realPath(PACKAGE).pipe(step("resolve package"))
  const hasApp = yield* fs.exists(installed).pipe(step("check app"))
  if (hasApp && (yield* fs.realPath(installed).pipe(step("resolve app"))) === source) {
    yield* launchctl("bootout", `${target}/${LABEL}`)
    yield* fs.writeFileString(plist, body).pipe(step(`write ${plist}`))
    yield* start
    return { plist, log, app, commit: undefined, agents: undefined, overridden: [], notes: [] }
  }

  // 1. Stage the replacement next to the running copy.
  const next = `${app}.next`
  const notes: string[] = []
  yield* fs.remove(next, { recursive: true, force: true }).pipe(step(`remove ${next}`))
  for (const [name, dirs, files] of [["atomic-agents", ["src", "domains"], ["package.json", "bun.lock"]], ["chat-core", ["src"], ["package.json"]]] as const) {
    const [from, to] = [path.join(source, "..", name), path.join(next, name)]
    yield* fs.makeDirectory(to, { recursive: true }).pipe(step(`create ${to}`))
    for (const dir of dirs) yield* fs.copy(path.join(from, dir), path.join(to, dir)).pipe(step(`copy ${name}/${dir}`))
    for (const file of files) yield* fs.copyFile(path.join(from, file), path.join(to, file)).pipe(step(`copy ${name}/${file}`))
  }
  const staged = path.join(next, "atomic-agents")
  const deps = yield* exec(process.execPath, ["install", "--production", "--frozen-lockfile"], { cwd: staged }).pipe(step("bun install"))
  if (deps.exitCode !== 0) return yield* new ServiceError({ message: `bun install in ${staged}: ${deps.stderr.trim()}` })
  // bun links `file:` dependencies by absolute path (chat-core's files into the stage); relative links survive the rename.
  const modules = path.join(staged, "node_modules")
  for (const name of yield* fs.readDirectory(modules, { recursive: true }).pipe(step(`list ${modules}`))) {
    const link = path.join(modules, name)
    const linked = yield* fs.readLink(link).pipe(Effect.option)
    if (Option.isNone(linked) || !linked.value.startsWith(`${next}/`)) continue
    yield* fs.remove(link).pipe(step(`remove link ${link}`))
    yield* fs.symlink(path.relative(path.dirname(link), linked.value), link).pipe(step(`link ${link}`))
  }
  const git = (...args: ReadonlyArray<string>) =>
    exec("git", args, { cwd: source }).pipe(
      Effect.map((result) => result.exitCode === 0 ? result.stdout.trim() : undefined),
      Effect.orElseSucceed(() => undefined)
    )
  const gitDir = yield* git("rev-parse", "--path-format=absolute", "--git-common-dir")
  const prefix = yield* git("rev-parse", "--show-prefix")
  const commit = yield* git("rev-parse", "HEAD")
  if (gitDir !== undefined && prefix !== undefined && commit !== undefined) {
    const origin = { gitDir, package: prefix.replace(/\/$/, ""), commit, installedAt: new Date().toISOString() }
    yield* fs.writeFileString(path.join(next, "source.json"), `${JSON.stringify(origin, null, 2)}\n`).pipe(step("write source.json"))
  }

  // 2. Gate: the source, then what the staged copy loads against what runs now and what config.json counts on.
  const before = yield* fs.readFileString(path.join(app, "source.json")).pipe(
    Effect.map(decodeInstallSource),
    Effect.orElseSucceed(() => Option.none())
  )
  const probe = yield* probeSource(source, [".", "../chat-core"], options.base, Option.getOrUndefined(before)?.commit)
  if (probe.warning !== undefined) notes.push(probe.warning)
  const refusals = [...sourceRefusals(probe.facts)]
  const rosterOf = (copy: string) =>
    exec(process.execPath, [path.join(copy, "atomic-agents", "src", "cli.ts"), "list", "--json"], { env: { ATOMIC_AGENTS_HOME: root } }).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? decodeRoster(result.stdout.trim().split("\n").at(-1) ?? "")
          : Effect.fail(new Error(result.stderr.trim().split("\n").at(-1) ?? `exit ${result.exitCode}`))
      ),
      Effect.mapError((error) => new ServiceError({ message: `list --json in ${copy}: ${error.message}` }))
    )
  const nextRoster = yield* rosterOf(next)
  const loaded = hasApp
    ? yield* rosterOf(app).pipe(
      Effect.catch((error) => {
        refusals.push(`cannot read the installed roster, so cannot tell what it would drop: ${error.message}`)
        return Effect.succeed(undefined)
      })
    )
    : undefined
  const configFile = path.join(root, "config.json")
  const config = (yield* fs.exists(configFile).pipe(step("check config.json")))
    ? yield* fs.readFileString(configFile).pipe(
      step("read config.json"),
      Effect.flatMap(decodeConfig),
      Effect.catch((error) => {
        refusals.push(`cannot read the modes in ${configFile}: ${error.message}`)
        return Effect.succeed({})
      })
    )
    : {}
  for (const { id, why } of rosterLosses(loaded, nextRoster, config)) refusals.push(`would drop ${id}: ${why}`)
  if (refusals.length > 0 && !options.force) {
    yield* fs.remove(next, { recursive: true, force: true }).pipe(step(`remove ${next}`))
    return yield* new ServiceError({
      message: `refusing to replace ${app} from ${source}; the running service is untouched:\n${refusals.map((reason) => `  - ${reason}`).join("\n")}\ninstall from an up-to-date checkout of ${options.base}, or rerun with --force to install anyway`
    })
  }

  // 3. Swap: the service is down only between bootout and bootstrap.
  const prev = `${app}.prev`
  yield* launchctl("bootout", `${target}/${LABEL}`)
  yield* fs.remove(prev, { recursive: true, force: true }).pipe(step(`remove ${prev}`))
  if (yield* fs.exists(app).pipe(step("check app"))) yield* fs.rename(app, prev).pipe(step(`move ${app} to ${prev}`))
  yield* fs.rename(next, app).pipe(step(`move ${next} to ${app}`))
  yield* fs.writeFileString(plist, body).pipe(step(`write ${plist}`))
  yield* start.pipe(
    Effect.catch((error) =>
      Effect.gen(function*() {
        if (!(yield* fs.exists(prev).pipe(step("check prev")))) return yield* error
        yield* launchctl("bootout", `${target}/${LABEL}`)
        yield* fs.rename(app, next).pipe(step(`move ${app} back to ${next}`))
        yield* fs.rename(prev, app).pipe(step(`restore ${prev}`))
        yield* start
        return yield* new ServiceError({ message: `the new copy did not start (${error.message}); restored the previous one, the new one is in ${next}` })
      })
    )
  )
  return { plist, log, app, commit, agents: nextRoster.filter((row) => row.error === undefined).length, overridden: refusals, notes }
})

export const uninstall = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const { plist, target } = yield* paths
  yield* launchctl("bootout", `${target}/${LABEL}`)
  yield* fs.remove(plist, { force: true }).pipe(step(`remove ${plist}`))
  return { plist }
})

export const status = Effect.gen(function*() {
  const { plist, log, target } = yield* paths
  const result = yield* launchctl("print", `${target}/${LABEL}`)
  const field = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, "m").exec(result.stdout)?.[1]?.trim()
  return {
    loaded: result.exitCode === 0,
    state: field("state") ?? "not loaded",
    pid: field("pid"),
    lastExit: field("last exit code"),
    /** What launchd actually runs (bun, the installed cli.ts, serve). */
    command: /^\s*arguments = \{\n([\s\S]*?)\n\s*\}/m.exec(result.stdout)?.[1]?.split("\n").map((line) => line.trim()).join(" "),
    plist,
    log
  }
})
