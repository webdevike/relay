// Whether omp on this Mac has an AI account to think with. A new user whose sign-in did not finish
// has none: omp then starts, registers with the bridge and sits on "No model selected", so an
// assistant's first prompt never runs. The host checks before it launches one and says so.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Keys omp reads from its environment or `~/.omp/agent/.env` (omp.sh/docs/providers). */
const KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"];

export interface AiAccountDeps {
  /** `omp usage accounts --json`'s stdout; null when omp could not be run. */
  readonly accountsJson: () => Promise<string | null>;
  readonly env: Record<string, string | undefined>;
  /** omp's agent dir, `~/.omp/agent`. */
  readonly agentDir: string;
}

/**
 * true when omp has a model account (an OAuth sign-in or an API key), false when it surely has none,
 * null when it cannot tell (omp would not run, or a custom provider file may supply one).
 */
export async function hasAiAccount(deps: AiAccountDeps): Promise<boolean | null> {
  if (KEY_VARS.some((name) => (deps.env[name] ?? "") !== "")) return true;
  const envFile = join(deps.agentDir, ".env");
  if (existsSync(envFile)) {
    const text = readFileSync(envFile, "utf8");
    if (KEY_VARS.some((name) => new RegExp(`^${name}=.+`, "m").test(text))) return true;
  }
  const raw = await deps.accountsJson();
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { accounts?: Array<{ provider?: unknown }> };
    // mcp_oauth:* entries are MCP server sign-ins, not model providers (as setup's detect.sh reads them).
    const models = (parsed.accounts ?? []).filter(
      (a) => typeof a.provider === "string" && !a.provider.startsWith("mcp_oauth"),
    );
    if (models.length > 0) return true;
  } catch {
    return null;
  }
  return existsSync(join(deps.agentDir, "models.yml")) ? null : false;
}

/** The real check, with omp at `omp` (null: not found, so nothing can be said). */
export function ompAccounts(omp: string | null): AiAccountDeps {
  return {
    accountsJson: async () => {
      if (omp === null) return null;
      try {
        const proc = Bun.spawn([omp, "usage", "accounts", "--json"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        });
        const timer = setTimeout(() => proc.kill(), 10_000);
        const out = await new Response(proc.stdout).text();
        clearTimeout(timer);
        return (await proc.exited) === 0 ? out : null;
      } catch {
        return null;
      }
    },
    env: process.env,
    agentDir: join(homedir(), ".omp", "agent"),
  };
}

/** Where the host's log is, for an error a user can hand to support; null where it is not known. */
export function hostLogPath(): string | null {
  return process.platform === "darwin" ? "~/Library/Logs/RelayHost.log" : null;
}
