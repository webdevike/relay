import { Effect, FileSystem, Path, type PlatformError, Schedule, Schema } from "effect"
import { exec } from "./exec.ts"
import { Home } from "./Event.ts"

/**
 * `serve` as its own macOS LaunchAgent (Eva's `ai.eva.*` family): KeepAlive, logs under the home dir.
 * It runs an installed copy in `<home>/app/atomic-agents`, never a checkout, so removing a worktree cannot break it.
 */
export const LABEL = "ai.eva.atomic-agents"
const PACKAGE = new URL("..", import.meta.url).pathname
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

/**
 * Copy this package (src, package.json, bun.lock) into `<home>/app/atomic-agents` and the chat-core sources
 * it depends on (`file:../chat-core`, Relay's widget parser) into `<home>/app/chat-core`, side by side as in
 * the repo; install production dependencies, write the plist and (re)load it. Run from the installed copy it
 * only reloads. Blender runs `-b` only, so the service never takes focus.
 */
export const install = Effect.gen(function*() {
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
  // Stop the old instance first: it may be running from the copy about to be replaced.
  yield* launchctl("bootout", `${target}/${LABEL}`)
  const source = yield* fs.realPath(PACKAGE).pipe(step("resolve package"))
  const current = (yield* fs.exists(installed).pipe(step("check app"))) && (yield* fs.realPath(installed).pipe(step("resolve app"))) === source
  if (!current) {
    yield* fs.remove(app, { recursive: true, force: true }).pipe(step(`remove ${app}`))
    for (const [name, dirs, files] of [["atomic-agents", ["src"], ["package.json", "bun.lock"]], ["chat-core", ["src"], ["package.json"]]] as const) {
      const [from, to] = [path.join(source, "..", name), path.join(app, name)]
      yield* fs.makeDirectory(to, { recursive: true }).pipe(step(`create ${to}`))
      for (const dir of dirs) yield* fs.copy(path.join(from, dir), path.join(to, dir)).pipe(step(`copy ${name}/${dir}`))
      for (const file of files) yield* fs.copyFile(path.join(from, file), path.join(to, file)).pipe(step(`copy ${name}/${file}`))
    }
    const deps = yield* exec(process.execPath, ["install", "--production", "--frozen-lockfile"], { cwd: installed }).pipe(step("bun install"))
    if (deps.exitCode !== 0) return yield* new ServiceError({ message: `bun install in ${installed}: ${deps.stderr.trim()}` })
  }
  yield* fs.writeFileString(plist, body).pipe(step(`write ${plist}`))
  // bootout is asynchronous; bootstrap fails with EIO until the old instance is gone.
  yield* launchctl("bootstrap", target, plist).pipe(
    Effect.flatMap((result) => result.exitCode === 0 ? Effect.void : Effect.fail(new ServiceError({ message: result.stderr.trim() }))),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 })
  )
  return { plist, log, app }
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
