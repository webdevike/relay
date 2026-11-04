import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANVAS_TOOLS, DEFAULT_CANVAS_AGENT, canvasAgentConfig, mindArgs } from "../src/canvas/agent-config";
import { draftLine, statusLine } from "../src/canvas/agent";
import { canvasGuard, guardExtension, type GuardPolicy } from "../src/canvas/guard";

const policy: GuardPolicy = {
  cwd: "/Users/ike/Eva",
  home: "/Users/ike",
  writeRoots: ["/Users/ike/Eva/work"],
  writeFiles: ["/Users/ike/Library/Application Support/EvaOS/canvases/test-board.json"],
};
const guard = (tool: string, input: Record<string, unknown>): string | null => canvasGuard(tool, input, policy);

describe("canvas agent config", () => {
  it("defaults to Opus at low effort with a per-room budget", () => {
    expect(canvasAgentConfig({})).toEqual(DEFAULT_CANVAS_AGENT);
    expect(DEFAULT_CANVAS_AGENT).toMatchObject({ model: "opus", effort: "low" });
  });

  it("reads model, effort and limits from the environment, and refuses bad values", () => {
    expect(
      canvasAgentConfig({ RELAY_CANVAS_MODEL: "sonnet", RELAY_CANVAS_EFFORT: "medium", RELAY_CANVAS_MAX_TURNS: "40", RELAY_CANVAS_MAX_TOKENS: "900000", RELAY_CANVAS_MAX_TURN_MIN: "5", RELAY_CANVAS_IDLE_STOP_MIN: "2.5" }),
    ).toEqual({ model: "sonnet", effort: "medium", maxRequests: 40, maxTokens: 900_000, maxTurnMs: 300_000, idleStopMs: 150_000 });
    expect(() => canvasAgentConfig({ RELAY_CANVAS_MODEL: "gpt" })).toThrow(/RELAY_CANVAS_MODEL must be one of opus, sonnet, haiku/);
    expect(() => canvasAgentConfig({ RELAY_CANVAS_EFFORT: "high" })).toThrow(/low or medium/);
    expect(() => canvasAgentConfig({ RELAY_CANVAS_MAX_TURNS: "0" })).toThrow(/positive/);
    expect(() => canvasAgentConfig({ RELAY_CANVAS_MAX_TOKENS: "lots" })).toThrow(/positive/);
  });

  it("runs omp as a saved RPC session with the normal tools, the guard as its only extension, and the canvas prompt appended", () => {
    const args = mindArgs({
      omp: "/bin/omp",
      profile: "personal",
      configs: ["/cfg/canvas-mind.yml"],
      baseConfig: "/home/.omp/agent/config.yml",
      cwd: "/Users/ike/Eva",
      sessionDir: "/state/room-1/session",
      guard: "/state/room-1/canvas-guard.ts",
      model: "opus",
      effort: "low",
      appendSystemPrompt: "You are Nova on a live canvas",
    });
    const flag = (name: string): string | undefined => args[args.indexOf(name) + 1];
    expect(args[0]).toBe("/bin/omp");
    expect(flag("--profile")).toBe("personal");
    expect(args.filter((a, i) => args[i - 1] === "--config")).toEqual(["/home/.omp/agent/config.yml", "/cfg/canvas-mind.yml"]);
    expect(flag("--mode")).toBe("rpc");
    expect(flag("--model")).toBe("anthropic/claude-opus-5-5");
    expect(flag("--thinking")).toBe("low");
    expect(flag("--cwd")).toBe("/Users/ike/Eva");
    expect(flag("--session-dir")).toBe("/state/room-1/session");
    expect(flag("--append-system-prompt")).toBe("You are Nova on a live canvas");
    expect(args).toContain("--no-extensions");
    expect(flag("--extension")).toBe("/state/room-1/canvas-guard.ts");
    expect(flag("--tools")?.split(",")).toEqual([...CANVAS_TOOLS]);
    for (const tool of ["read", "bash", "edit", "write", "grep", "glob", "task", "web_search", "browse"]) expect(CANVAS_TOOLS).toContain(tool);
    expect(CANVAS_TOOLS).not.toContain("eval");
    // Unlike the old board-only brain: tools on, a saved session, real thinking.
    expect(args).not.toContain("--no-tools");
    expect(args).not.toContain("--no-session");
    expect(args).not.toContain("--system-prompt");
    expect(mindArgs({ omp: "omp", profile: null, configs: [], baseConfig: "/c.yml", cwd: "/w", sessionDir: "/s", guard: "/g.ts", model: "haiku", effort: "medium", appendSystemPrompt: "x" })).not.toContain("--profile");
  });

  it("turns a tool call into a short status line", () => {
    expect(statusLine("bash", "Rendering the mockup.")).toBe("rendering the mockup…");
    expect(statusLine("web_search", "")).toBe("searching the web…");
    expect(statusLine("mystery", "")).toBe("working…");
  });

  it("names what a tool call being written will put on the board, so a long JSX call is not a silent gap", () => {
    expect(draftLine('{"script":"@say Building it now.\\n@add_proto inbox 900 0 1000 640 relay\\nInbox\\nconst [sel')).toBe("building the mockup…");
    expect(draftLine('{"script":"@add_node n note 0 0 400\\nA\\n@end\\n@add_ui w 0 0 400\\nJobs')).toBe("building a live widget…");
    expect(draftLine('{"script":"@set_text inbox-proto body\\nconst')).toBe("rewriting a card…");
    expect(draftLine('{"script":"@say hi')).toBeNull();
    expect(draftLine(`{"command":"${"x".repeat(500)}`)).toBe("working…");
  });
});

describe("canvas approval guard", () => {
  it("lets it read, research and work under work/", () => {
    expect(guard("read", { path: "/etc/hosts" })).toBeNull();
    expect(guard("grep", { pattern: "x", path: "/Users/ike/Eva" })).toBeNull();
    expect(guard("web_search", { query: "mantine stepper" })).toBeNull();
    expect(guard("task", { context: "c", tasks: [] })).toBeNull();
    expect(guard("browse", { goal: "open mantine.dev and screenshot the Stepper docs" })).toBeNull();
    expect(guard("write", { path: "work/canvas/test-board/mock.html", content: "<h1/>" })).toBeNull();
    expect(guard("write", { path: "/Users/ike/Eva/work/canvas/x.png" })).toBeNull();
    expect(guard("write", { path: "local://notes.md", content: "x" })).toBeNull();
    expect(guard("write", { path: "/Users/ike/Library/Application Support/EvaOS/canvases/test-board.json", content: "{}" })).toBeNull();
    expect(guard("edit", { input: "[work/canvas/mock.tsx#1A2B]\nPUT 1:\n+x" })).toBeNull();
    expect(guard("bash", { command: "mkdir -p work/canvas/b && cd work/canvas/b && bunx playwright screenshot mock.html shot.png > log.txt 2>&1" })).toBeNull();
    expect(guard("bash", { command: "git -C work/relay-canvas-agent log --oneline -3 | cat" })).toBeNull();
    expect(guard("bash", { command: "curl -sIL https://cdn.dribbble.com/a.png" })).toBeNull();
    expect(guard("bash", { command: "curl -s -X POST http://127.0.0.1:8787/canvas/sessions/b/self/act -d '{}'" })).toBeNull();
    expect(guard("bash", { command: "bun ~/Eva/work/relay/apps/linux/src/main.ts canvas act b - <<'EOF'\n@say sending the mockup now\n@add_node n note 0 0 400\nTo ssh or not\n@end\nEOF" })).toBeNull();
  });

  it("refuses writes outside work/ and the board file", () => {
    expect(guard("write", { path: "/Users/ike/Eva/AGENTS.md", content: "x" })).toMatch(/^Refused: \/Users\/ike\/Eva\/AGENTS.md is outside the canvas's write area/);
    expect(guard("write", { path: "work/../memory/journal.md", content: "x" })).toMatch(/outside the canvas's write area/);
    expect(guard("write", { path: "/Users/ike/Library/Application Support/EvaOS/canvases/other.json", content: "{}" })).toMatch(/outside/);
    expect(guard("write", { path: "xd://mcp__higgsfield_generate_image", content: "{}" })).toMatch(/needs Isaac's yes/);
    expect(guard("edit", { input: "[apps/linux/src/main.ts#1A2B]\nPUT 1:\n+x" })).toMatch(/outside the canvas's write area/);
    expect(guard("edit", { input: "[work/a.ts#1A2B]\nMV ../outside.ts" })).toMatch(/outside/);
    expect(guard("bash", { command: "echo hi > ~/.zshrc" })).toMatch(/\/Users\/ike\/.zshrc is outside/);
    expect(guard("bash", { command: "cd /tmp && rm -rf build" })).toMatch(/\/tmp\/build is outside/);
    expect(guard("bash", { command: "cp work/a.png /Users/ike/Desktop/" })).toMatch(/Desktop is outside/);
    expect(guard("bash", { command: "sed -i '' s/a/b/ AGENTS.md" })).toMatch(/AGENTS.md is outside/);
    expect(guard("bash", { command: "git commit -am wip" })).toMatch(/\/Users\/ike\/Eva is outside/);
    expect(guard("bash", { command: "cat x | tee /etc/hosts" })).toMatch(/\/etc\/hosts is outside/);
  });

  it("refuses anything external or in Isaac's name, pointing it at the chat", () => {
    const external = [
      ["bash", { command: "git -C work/relay push origin eva/x" }],
      ["bash", { command: "gh pr create --fill" }],
      ["bash", { command: "gh api repos/x/y/issues -f title=hi" }],
      ["bash", { command: "cd work/site && wrangler deploy" }],
      ["bash", { command: "npm publish" }],
      ["bash", { command: "osascript -e 'tell app \"Messages\" to send'" }],
      ["bash", { command: "bun .omp/tools/eva-thread.ts --agent astra hi" }],
      ["bash", { command: "curl -X POST https://hooks.slack.com/x -d '{}'" }],
      ["bash", { command: "curl --data 'a=1' https://api.stripe.com/v1/charges" }],
      ["bash", { command: "ssh mini 'ls'" }],
      ["bash", { command: "sudo launchctl kickstart gui/501/relay" }],
      ["bash", { command: "brew install ffmpeg" }],
      ["browse", { goal: "open amazon and buy the cable" }],
      ["browse", { goal: "read the inbox", cdp: "http://127.0.0.1:9222" }],
      ["computer_run", { window_id: 1, steps: [] }],
      ["mcp__openseo_run_site_audit", {}],
    ] as const;
    for (const [tool, input] of external) expect(guard(tool, input), `${tool} ${JSON.stringify(input)}`).toMatch(/Refused: .*(needs Isaac's yes|outside the canvas's lane)/);
    expect(guard("bash", { command: "git push" })).toContain("@handoff main");
    expect(guard("eval", { code: "1" })).toMatch(/eval is not available/);
  });

  it("is the same code in the extension omp loads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-guard-"));
    try {
      // omp loads it as TypeScript; the generated source is plain JavaScript, so node can import it as .mjs.
      const file = join(dir, "canvas-guard.mjs");
      writeFileSync(file, guardExtension(policy));
      expect(readFileSync(file, "utf8")).toContain("Generated by the Relay host");
      // The extension file is generated at runtime, so only a dynamic import can load it as omp does.
      const mod = (await import(file)) as { default: (pi: { on: (event: string, fn: (e: { toolName: string; input: Record<string, unknown> }) => unknown) => void }) => void };
      const handlers: ((e: { toolName: string; input: Record<string, unknown> }) => unknown)[] = [];
      mod.default({ on: (event, fn) => event === "tool_call" && handlers.push(fn) });
      expect(handlers).toHaveLength(1);
      const blocked = handlers[0]?.({ toolName: "bash", input: { command: "git push" } }) as { block: boolean; reason: string } | undefined;
      expect(blocked?.block).toBe(true);
      expect(blocked?.reason).toContain("pushing to a remote");
      expect(handlers[0]?.({ toolName: "write", input: { path: "work/canvas/a.txt" } })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
