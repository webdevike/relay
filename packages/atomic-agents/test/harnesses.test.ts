import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Adapters } from "../src/core/Adapter.ts";
import { claudeCode, parseClaude } from "../src/core/adapters/claude-code.ts";
import { codex, parseCodex } from "../src/core/adapters/codex.ts";
import { harnessEffort } from "../src/core/adapters/harness.ts";
import { ModelRunner } from "../src/core/Model.ts";

const jsonl = (events: ReadonlyArray<unknown>) =>
  events.map((event) => JSON.stringify(event)).join("\n");

describe("codex harness output", () => {
  test("the reply is the last agent message; usage sums every turn with cache reads split out of input", () => {
    const parsed = parseCodex(
      jsonl([
        { type: "thread.started", thread_id: "t" },
        {
          type: "item.completed",
          item: { id: "0", type: "agent_message", text: "Let me write it." },
        },
        {
          type: "item.completed",
          item: { id: "1", type: "error", message: "code-mode host is disabled" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 },
        },
        {
          type: "item.completed",
          item: { id: "2", type: "agent_message", text: "```python\ndef build(): pass\n```" },
        },
        { type: "turn.completed", usage: { input_tokens: 200, output_tokens: 30 } },
      ]),
    );
    expect(parsed).toEqual({
      ok: true,
      text: "```python\ndef build(): pass\n```",
      tokens: { input: 600, output: 80, cachedInput: 600 },
    });
  });

  test("no completed turn fails with codex's last error; a completed turn with no message is an empty reply", () => {
    expect(
      parseCodex(
        jsonl([
          { type: "error", message: "Reconnecting... 1/5" },
          { type: "turn.failed", error: { message: "usage limit reached" } },
        ]),
      ),
    ).toEqual({ ok: false, message: "usage limit reached" });
    expect(parseCodex("not json")).toEqual({ ok: false, message: "no completed turn" });
    expect(
      parseCodex(
        jsonl([{ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 0 } }]),
      ),
    ).toEqual({ ok: false, message: "empty reply" });
  });
});

describe("claude-code harness output", () => {
  test("the result text, Claude Code's list cost, and tokens with cache writes counted as input", () => {
    const parsed = parseClaude(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "def build(): pass",
        total_cost_usd: 0.0173,
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 2133,
          cache_read_input_tokens: 658,
          output_tokens: 5,
        },
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      text: "def build(): pass",
      cost: 0.0173,
      tokens: { input: 2135, output: 5, cachedInput: 658 },
    });
  });

  test("an error result fails with its message; anything but a result object fails", () => {
    expect(
      parseClaude(
        JSON.stringify({ type: "result", is_error: true, result: "Credit balance is too low" }),
      ),
    ).toEqual({
      ok: false,
      message: "Credit balance is too low",
    });
    expect(parseClaude("Error: not logged in")).toEqual({ ok: false, message: "no result object" });
  });
});

describe("harness routing", () => {
  const generate = (harness: string, model: string, files?: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const adapter = (yield* Adapters).models.get(harness)!;
      return yield* Effect.flip(
        adapter.generate({
          model,
          system: "s",
          prompt: "p",
          ...(files === undefined ? {} : { files }),
        }),
      );
    }).pipe(
      Effect.provide(
        Adapters.make([codex, claudeCode]).pipe(
          Layer.provideMerge(
            Layer.succeed(ModelRunner, ModelRunner.of({ generate: () => Effect.die("unused") })),
          ),
          Layer.provideMerge(BunServices.layer),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    );

  test("each native harness refuses another vendor's model before it starts, and claude-code refuses attached files", async () => {
    expect((await generate("codex", "anthropic/claude-opus-5-5")).message).toBe(
      "the codex harness runs OpenAI models only",
    );
    expect((await generate("claude-code", "openai-codex/gpt-6-astra")).message).toBe(
      "the claude-code harness runs Anthropic models only",
    );
    expect(
      (await generate("claude-code", "anthropic/claude-opus-5-5", ["/tmp/a.png"])).message,
    ).toBe("the claude-code harness runs with tools off and cannot attach files");
  });

  test("thinking off and minimal run at the lowest native effort; other levels and unset pass through", () => {
    expect([
      harnessEffort("off"),
      harnessEffort("minimal"),
      harnessEffort("high"),
      harnessEffort(undefined),
    ]).toEqual(["low", "low", "high", undefined]);
  });
});
