// The sign-in handoff: an assistant thread ends a reply with `[[signin:<url>]]` when a site wants
// Isaac to log in (the token's parser, `splitSignin`, is in @relay/protocol), and the phone or Relay
// desktop answers with `assistant.signin` for that agent. The host hands the credentials to
// `<agentHome>/.omp/tools/eva-browser.ts fill <url>` on stdin, which types them into the login page
// in Eva's contained browser. The credentials never reach argv, the log or the model.

import { join } from "node:path";
import { AckFailure } from "../seams";

/** The tool that fills the login page, under the agent home. */
export const EVA_BROWSER_TOOL = join(".omp", "tools", "eva-browser.ts");
/** The tool waits up to 10 s per step and a form can take two; past this the host gives up on it. */
export const FILL_TIMEOUT_MS = 60_000;
/** Longest tool error the phone is shown. */
export const MAX_FILL_ERROR = 300;

/** What the host needs of a spawned process: stdin to write the credentials to, and its end. */
export interface FillProcess {
  readonly stdin: { write(chunk: string): unknown; end(): unknown };
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}
/** Starts `argv` with piped stdin and stderr (`Bun.spawn`, in the host). */
export type FillSpawn = (argv: readonly string[], cwd: string) => FillProcess;

/** Spawns the tool the way the host runs it: `bun` in the agent home, stdin and stderr piped. */
export const spawnFill: FillSpawn = (argv, cwd) => {
  const proc = Bun.spawn([...argv], { cwd, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  return {
    stdin: proc.stdin,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => {
      proc.kill();
    },
  };
};

/**
 * Runs `eva-browser.ts fill <url>` with `{"username","password"}` on stdin and waits for it. Resolves
 * on exit 0; otherwise rejects with `invalid_command` carrying the tool's one-line stderr.
 */
export async function runFill(
  spawn: FillSpawn,
  agentHome: string,
  url: string,
  credentials: { readonly username: string; readonly password: string },
): Promise<void> {
  let proc: FillProcess;
  try {
    proc = spawn(["bun", join(agentHome, EVA_BROWSER_TOOL), "fill", url], agentHome);
  } catch (error) {
    throw new AckFailure({ code: "internal", message: `could not start the browser tool: ${error instanceof Error ? error.message : String(error)}` });
  }
  const timer = setTimeout(() => {
    proc.kill();
  }, FILL_TIMEOUT_MS);
  try {
    // The tool may exit without reading stdin; the broken pipe is then the tool's story, not ours.
    try {
      proc.stdin.write(JSON.stringify(credentials));
      await Promise.resolve(proc.stdin.end());
    } catch {
      // Reported through the exit code and stderr below.
    }
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code === 0) return;
    const line = stderr.split("\n").map((row) => row.trim()).filter((row) => row.length > 0).at(-1) ?? "";
    const reason = line.length > 0 ? line : `eva-browser fill exited ${code}`;
    throw new AckFailure({ code: "invalid_command", message: reason.length > MAX_FILL_ERROR ? `${reason.slice(0, MAX_FILL_ERROR - 1)}…` : reason });
  } finally {
    clearTimeout(timer);
  }
}
