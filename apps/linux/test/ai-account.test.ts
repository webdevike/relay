import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasAiAccount } from "../src/assistant/ai-account";
import { noAccountMessage } from "../src/assistant/service";

const dirs: string[] = [];
const agentDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "relay-ai-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const deps = (json: string | null, dir = agentDir(), env: Record<string, string> = {}) => ({
  accountsJson: async () => json,
  env,
  agentDir: dir,
});

describe("hasAiAccount", () => {
  it("is false for omp with no accounts and no keys (a sign-in that never finished)", async () => {
    expect(await hasAiAccount(deps('{"accounts":[]}'))).toBe(false);
  });

  it("counts an OAuth sign-in, including one made by hand with `omp login`", async () => {
    expect(await hasAiAccount(deps('{"accounts":[{"provider":"openai-codex"}]}'))).toBe(true);
  });

  it("does not count MCP server sign-ins as a model account", async () => {
    expect(await hasAiAccount(deps('{"accounts":[{"provider":"mcp_oauth:linear"}]}'))).toBe(false);
  });

  it("counts an API key in omp's .env or the environment", async () => {
    const dir = agentDir();
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-test\n");
    expect(await hasAiAccount(deps('{"accounts":[]}', dir))).toBe(true);
    expect(
      await hasAiAccount(deps('{"accounts":[]}', agentDir(), { OPENAI_API_KEY: "sk-x" })),
    ).toBe(true);
  });

  it("cannot tell when omp does not answer or a custom provider file exists", async () => {
    expect(await hasAiAccount(deps(null))).toBeNull();
    const dir = agentDir();
    writeFileSync(join(dir, "models.yml"), "providers: {}\n");
    expect(await hasAiAccount(deps('{"accounts":[]}', dir))).toBeNull();
  });
});

describe("noAccountMessage", () => {
  it("says what failed, what to do and where the log is", () => {
    expect(noAccountMessage("Assistant", "~/Library/Logs/RelayHost.log")).toBe(
      "Assistant can't think yet: no AI account is signed in on this Mac. Open Settings > Setup in Relay and sign in with Claude or ChatGPT (or add an API key), then start Assistant again. Host log: ~/Library/Logs/RelayHost.log",
    );
  });
});
