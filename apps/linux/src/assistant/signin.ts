// The sign-in handoff: Eva ends a reply with `[[signin:<url>]]` when a site wants Isaac to log in,
// and the phone answers with `assistant.signin`. The host hands the credentials to
// `<agentHome>/.omp/tools/eva-browser.ts fill <url>` on stdin, which types them into the login page
// in Eva's contained browser. The credentials never reach argv, the log or the model.

import { join } from "node:path";
import type { AssistantMessage } from "@relay/protocol";
import { AckFailure } from "../seams";

/** The tool that fills the login page, under the agent home. */
export const EVA_BROWSER_TOOL = join(".omp", "tools", "eva-browser.ts");
/** The tool waits up to 10 s per step and a form can take two; past this the host gives up on it. */
export const FILL_TIMEOUT_MS = 60_000;
/** Longest tool error the phone is shown. */
export const MAX_FILL_ERROR = 300;

/** The token Eva ends a reply with. The url has no whitespace or `]`. */
const TOKEN = /[ \t\r\n]*\[\[signin:([^\]\s]+)\]\][ \t\r\n]*$/;
const OPENER = "[[signin:";

type Signin = NonNullable<AssistantMessage["signin"]>;

/** The hostname of an http(s) url; null for anything else. */
export function signinHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname.length > 0 ? parsed.hostname : null;
  } catch {
    return null;
  }
}

/**
 * Splits the sign-in token off the end of a reply. `signin` is set when the token carries an
 * http(s) url; a token with any other url is still cut from the text. While the reply is
 * `streaming`, a token that has only partly arrived is cut too, so no flicker of `[[sig` shows.
 */
export function splitSignin(text: string, streaming: boolean): { text: string; signin?: Signin } {
  const match = TOKEN.exec(text);
  if (match !== null) {
    const url = match[1] ?? "";
    const stripped = text.slice(0, match.index);
    const host = signinHost(url);
    return host === null ? { text: stripped } : { text: stripped, signin: { url, host } };
  }
  if (!streaming) return { text };
  let start = text.lastIndexOf("[[");
  if (start < 0 && text.endsWith("[")) start = text.length - 1;
  if (start < 0) return { text };
  const tail = text.slice(start);
  const partial = !tail.includes("]]") && (OPENER.startsWith(tail) || (tail.startsWith(OPENER) && !/\s/.test(tail.slice(OPENER.length))));
  return partial ? { text: text.slice(0, start).trimEnd() } : { text };
}

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
