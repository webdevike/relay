import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import { packs as defaultPacks } from "../../../src/packs.ts";
import { EventBus } from "../../../src/core/Event.ts";
import { type GenerateRequest, ModelRunner } from "../../../src/core/Model.ts";
import { Runner } from "../../../src/core/Runtime.ts";
import { builtinAgents, runtime, tempHome } from "../../../test/harness.ts";
import { ask, creativePack, parseOptions, THIN_CONTEXT } from "../adapters/pack.ts";
import { roll, seedKindOf } from "../adapters/seed.ts";

/** Answers each call with the next scripted reply text; records every request. */
const scripted = (replies: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<GenerateRequest>>([]);
    const models = ModelRunner.of({
      generate: (request) =>
        Ref.modify(seen, (all) => [all.length, [...all, request]]).pipe(
          Effect.map((index) => ({
            text: replies[Math.min(index, replies.length - 1)]!,
            model: request.model,
            provider: "test",
            seconds: 0,
            cost: 0.01,
          })),
        ),
    });
    return { models, seen };
  });

const reply = (options: ReadonlyArray<readonly [string, string, string]>, pick = 1) =>
  JSON.stringify({
    options: options.map(([option, avoided, why]) => ({ option, avoided, why })),
    pick,
    pickWhy: "It is the one only this project could use.",
  });

const REAL = "x".repeat(THIN_CONTEXT);

/** Run the shipped anti-average agent once over a temp home. */
const run = (input: Readonly<Record<string, unknown>>, replies: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const root = yield* tempHome;
    const dir = yield* builtinAgents(root, ["anti-average"]);
    const { models, seen } = yield* scripted(replies);
    const packs = [
      ...defaultPacks.filter((candidate) => candidate.name !== "creative"),
      creativePack(() => 0),
    ];
    return yield* Effect.gen(function* () {
      const result = yield* (yield* Runner).run("anti-average", "options", input, {
        model: "test/model",
      });
      const events = yield* (yield* EventBus).history;
      const output = events.find(
        (event) => event.type === "anti-average/creative.options" && event.run === result.run,
      );
      return {
        ok: result.ok,
        data: output?.data as Record<string, any> | undefined,
        requests: yield* Ref.get(seen),
      };
    }).pipe(Effect.provide(runtime(root, { dirs: [dir], packs }, models)));
  }).pipe(Effect.scoped);

describe("anti-average", () => {
  test(
    "the model gets the brief, the knowledge and the contract; a reply with the wrong count gets one repair and then ships with text and a pick",
    () =>
      Effect.gen(function* () {
        const good = reply(
          [
            [
              "Apacheta",
              "Soundly Scout",
              "A heap travellers leave at a pass, as a staging collection is.",
            ],
            ["Simpul", "Gather", "A knot ties loose finds into one bundle that can be undone."],
          ],
          2,
        );
        const { ok, data, requests } = yield* run(
          { kind: "name", brief: "Name the picks agent.", context: REAL, count: 2 },
          [reply([["Only", "Default", "Fits."]]), good],
        );
        expect(ok).toBe(true);
        expect(requests.length).toBe(2);
        expect(requests[0]!.prompt).toContain("Make 2 options.");
        expect(requests[0]!.prompt).toContain("No seed.");
        for (const heading of [
          "You are Isaac's counter to the average pick",
          "# The rule",
          "# Names and copy",
          "# Concepts",
          "# Visual directions",
          "## Reply and check",
        ]) {
          expect(requests[0]!.system).toContain(heading);
        }
        expect(requests[1]!.prompt).toContain("- 1 options, 2 asked for");
        expect(data!["attempts"]).toBe(2);
        expect(data!["pick"]).toBe(2);
        expect(data!["options"].map((row: { option: string }) => row.option)).toEqual([
          "Apacheta",
          "Simpul",
        ]);
        expect(data!["text"]).toContain("2. Simpul (pick)");
        expect(data!["text"]).toContain("moved away from: Gather");
        expect(data!["ask"]).toBeUndefined();
      }).pipe(Effect.runPromise),
    20_000,
  );

  test(
    "thin context rolls one seed per option from the kind's pool; a reply that stays invalid after the repair fails the run",
    () =>
      Effect.gen(function* () {
        const { ok, data, requests } = yield* run(
          { kind: "visual-direction", brief: "A poster for a night market.", count: 3 },
          ["not json at all"],
        );
        expect(ok).toBe(false);
        expect(data).toBeUndefined();
        expect(requests.length).toBe(2);
        expect(requests[0]!.prompt).toContain("Seed for option 1:");
        expect(requests[0]!.prompt).toContain("Seed for option 3:");
        expect(requests[0]!.prompt).toContain("method: woodcut");
        expect(requests[1]!.prompt).toContain("- the reply is not one JSON object");
      }).pipe(Effect.runPromise),
    20_000,
  );

  test("a seed has the axes of its kind; names and copy draw text seeds, concepts idea seeds, looks visual seeds", () => {
    expect(seedKindOf("name")).toBe("text");
    expect(seedKindOf("copy")).toBe("text");
    expect(seedKindOf("concept")).toBe("idea");
    expect(seedKindOf("visual-direction")).toBe("visual");
    expect(Object.keys(roll("text", () => 0))).toEqual([
      "voice",
      "entry",
      "register",
      "setting",
      "region",
      "anchor",
    ]);
    expect(Object.keys(roll("idea", () => 0))).toEqual([
      "verb",
      "constraint",
      "scale",
      "pressure",
      "setting",
      "region",
      "anchor",
    ]);
    // rng() < 0.5 draws a "no single object" anchor for visual seeds only.
    expect(Object.keys(roll("visual", () => 0))).toEqual([
      "method",
      "color",
      "layout",
      "type",
      "verb",
      "scale",
      "setting",
      "region",
      "anchor",
    ]);
    expect(roll("visual", () => 0)["anchor"]).toStartWith("no single object");
    expect(roll("visual", () => 0.99)["anchor"]).not.toStartWith("no single object");
    expect(roll("text", () => 0)["anchor"]).toBe("ladder");
    // The default random source varies between rolls.
    expect(
      new Set(Array.from({ length: 12 }, () => JSON.stringify(roll("idea")))).size,
    ).toBeGreaterThan(1);
  });

  test("context at the thin threshold starts from the context, shorter rolls seeds; the count defaults to five", () => {
    const base = { kind: "concept", brief: "A mechanic." } as const;
    expect(ask({ ...base, context: REAL }, () => 0)).toContain("Start every option from a fact");
    const thin = ask({ ...base, context: REAL.slice(1) }, () => 0);
    expect(thin).toContain("Make 5 options.");
    expect(thin.match(/Seed for option \d:/g)?.length).toBe(5);
    expect(ask({ ...base, count: 1 }, () => 0)).toContain("Make 1 option.");
  });

  test("parseOptions names every way a reply breaks the contract", () => {
    const row = (option: string, avoided = "Default", why = "Fits.") =>
      [option, avoided, why] as const;
    const problems = (text: string, wanted: number, kind: "name" | "copy" = "name") => {
      const parsed = parseOptions(text, wanted, kind);
      return parsed.ok ? [] : parsed.problems;
    };
    expect(problems(`Here:\n\`\`\`json\n${reply([row("A"), row("B")])}\n\`\`\``, 2)).toEqual([]);
    expect(problems(reply([row("Echo", "echo!")]), 1)).toEqual([
      "option 1: it is its own `avoided`; name the obvious pick it moved away from",
    ]);
    expect(problems(reply([row("Echo"), row("echo.")]), 2)).toEqual(["option 2 repeats option 1"]);
    expect(problems(reply([row("A", "", "")]), 1)).toEqual([
      "option 1: `avoided` is empty",
      "option 1: `why` is empty",
    ]);
    expect(problems(reply([row("Go!")]), 1, "copy")).toEqual([
      "option 1: an exclamation mark in copy",
    ]);
    expect(problems(reply([row("A")], 3), 1)).toEqual([
      "`pick` must be a whole number from 1 to 1",
    ]);
    expect(problems("{broken", 1)).toEqual(["the reply is not one JSON object"]);
  });
});
