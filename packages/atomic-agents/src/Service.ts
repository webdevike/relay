import { Effect, FileSystem, Path, Schedule, Schema } from "effect"
import { exec } from "./exec.ts"
import { Home } from "./Event.ts"

/** `serve` as its own macOS LaunchAgent (Eva's `ai.eva.*` family): KeepAlive, logs under the home dir. */
export const LABEL = "ai.eva.atomic-agents"
const CLI = new URL("./cli.ts", import.meta.url).pathname
const BLENDER_APP = "/Applications/Blender.app/Contents/MacOS/Blender"

export class ServiceError extends Schema.TaggedError<ServiceError>()("ServiceError", {
  message: Schema.String
}) {}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const paths = Effect.gen(function*() {
  const path = yield* Path.Path
  const home = yield* Home
  const user = Bun.env["HOME"] ?? ""
  return {
    plist: path.join(user, "Library", "LaunchAgents", `${LABEL}.plist`),
    log: path.join(home.root, "logs", "serve.log"),
    root: home.root,
    user,
    target: `gui/${process.getuid?.() ?? 501}`
  }
})

const launchctl = (...args: ReadonlyArray<string>) =>
  exec("launchctl", args).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(new ServiceError({ message: error.message }))))

/** Write the plist and (re)load it. Blender runs `-b` only, so the service never takes focus. */
export const install = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { plist, log, root, user, target } = yield* paths
  const blender = Bun.env["BLENDER"] ?? ((yield* fs.exists(BLENDER_APP).pipe(Effect.orElseSucceed(() => false))) ? BLENDER_APP : "blender")
  const env: Record<string, string> = {
    HOME: user,
    PATH: [path.dirname(process.execPath), path.join(user, ".local", "bin"), "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    ATOMIC_AGENTS_HOME: root,
    BLENDER: blender
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(process.execPath)}</string>
		<string>${xml(CLI)}</string>
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
  yield* fs.makeDirectory(path.dirname(log), { recursive: true }).pipe(Effect.orDie)
  yield* fs.makeDirectory(path.dirname(plist), { recursive: true }).pipe(Effect.orDie)
  yield* fs.writeFileString(plist, body).pipe(Effect.orDie)
  yield* launchctl("bootout", `${target}/${LABEL}`)
  // bootout is asynchronous; bootstrap fails with EIO until the old instance is gone.
  yield* launchctl("bootstrap", target, plist).pipe(
    Effect.flatMap((result) => result.exitCode === 0 ? Effect.void : Effect.fail(new ServiceError({ message: result.stderr.trim() }))),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 })
  )
  return { plist, log }
})

export const uninstall = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const { plist, target } = yield* paths
  yield* launchctl("bootout", `${target}/${LABEL}`)
  yield* fs.remove(plist, { force: true }).pipe(Effect.orDie)
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
    plist,
    log
  }
})
