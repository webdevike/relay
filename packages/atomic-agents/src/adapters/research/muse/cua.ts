/**
 * A cua-driver MCP client over stdio (`cua-driver mcp`), after Eva's `.omp/tools/lib/cua.ts`. It prefers
 * `--direct` when this process holds Accessibility and Screen Recording (an omp shell does) and otherwise
 * proxies through the CuaDriver.app daemon, which holds them itself: the LaunchAgent service has no grants
 * of its own, so it always lands on the daemon.
 */

export interface Reply {
  readonly error?: { readonly message?: string }
  readonly result?: {
    readonly isError?: boolean
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
    readonly structuredContent?: Record<string, unknown>
  }
}

export interface Cua {
  call(name: string, args: Readonly<Record<string, unknown>>): Promise<Reply>
  close(): void
}

const ENV = {
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
  CUA_DRIVER_RS_UPDATE_CHECK: "0",
  CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS: "150",
  CUA_DRIVER_WINDOW_CHANGE_POLL_MS: "25"
}
const CALL_TIMEOUT = 60_000

export const textOf = (reply: Reply) =>
  reply.error?.message ?? (reply.result?.content ?? []).flatMap((block) => block.type === "text" && block.text !== undefined ? [block.text] : []).join(" ").trim()

export const failed = (reply: Reply) => reply.error !== undefined || reply.result?.isError === true

const spawn = (args: ReadonlyArray<string>): Cua => {
  const proc = Bun.spawn(["cua-driver", "mcp", ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, ...ENV } })
  const pending = new Map<number, (reply: Reply) => void>()
  let next = 1
  void (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const message = JSON.parse(line) as Reply & { id?: number }
          if (typeof message.id === "number") {
            pending.get(message.id)?.(message)
            pending.delete(message.id)
          }
        } catch {
          // Not a JSON-RPC line (driver log noise).
        }
      }
    }
    for (const resolve of pending.values()) resolve({ error: { message: "cua-driver exited" } })
    pending.clear()
  })()
  const rpc = (method: string, params: Readonly<Record<string, unknown>>) =>
    new Promise<Reply>((resolve) => {
      const id = next++
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve({ error: { message: `cua-driver ${method}: no answer in ${CALL_TIMEOUT / 1000} s` } })
      }, CALL_TIMEOUT)
      pending.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      proc.stdin.flush()
    })
  const ready = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "atomic-agents-muse", version: "1" } }).then(() => {
    proc.stdin.write("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
    proc.stdin.flush()
  })
  return {
    call: async (name, args) => {
      await ready
      return rpc("tools/call", { name, arguments: args })
    },
    close: () => proc.kill()
  }
}

/** The direct backend when this process may use it, else the CuaDriver.app daemon. */
export const connectCua = async (): Promise<Cua> => {
  const direct = spawn(["--direct"])
  const permissions = (await direct.call("check_permissions", {})).result?.structuredContent
  if (permissions?.["accessibility"] === true && permissions?.["screen_recording"] === true) return direct
  direct.close()
  return spawn([])
}
