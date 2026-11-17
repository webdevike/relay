import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Ref } from "effect";
import { packs as defaultPacks } from "../../../src/packs.ts";
import { EventBus } from "../../../src/core/Event.ts";
import { type GenerateRequest, ModelRunner } from "../../../src/core/Model.ts";
import { Runner } from "../../../src/core/Runtime.ts";
import { builtinAgents, runtime, tempHome } from "../../../test/harness.ts";
import { diagramPack, extractSvg, standalone } from "../adapters/pack.ts";
import type { Found } from "../adapters/page.ts";
import { Renderer } from "../adapters/renderer.ts";

const KNOWLEDGE = new URL("../agents/diagram/knowledge/", import.meta.url).pathname;

const svg = (marker: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 600"><title id="t-title">T</title><desc id="t-desc">D</desc><text>${marker}</text></svg>`;

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
            cost: 0.02,
          })),
        ),
    });
    return { models, seen };
  });

/** A renderer that never starts Chromium: an SVG holding a key of `problems` renders with those, anything else clean. */
const fakeRenderer = (problems: Readonly<Record<string, ReadonlyArray<Found>>>) =>
  Layer.succeed(
    Renderer,
    Renderer.of({
      render: (source, _theme, png) => {
        const key = Object.keys(problems).find((candidate) => source.includes(candidate));
        return Effect.succeed({
          width: 960,
          height: 600,
          png,
          problems: key === undefined ? [] : problems[key]!,
        });
      },
    }),
  );

/** Run the shipped diagram agent once over a temp home; answer its diagram.rendered data and the model requests. */
const draw = (
  input: Readonly<Record<string, unknown>>,
  replies: ReadonlyArray<string>,
  problems: Readonly<Record<string, ReadonlyArray<Found>>>,
) =>
  Effect.gen(function* () {
    const root = yield* tempHome;
    const dir = yield* builtinAgents(root, ["diagram"]);
    const { models, seen } = yield* scripted(replies);
    const packs = [
      ...defaultPacks.filter((candidate) => candidate.name !== "diagram"),
      diagramPack(fakeRenderer(problems)),
    ];
    return yield* Effect.gen(function* () {
      const result = yield* (yield* Runner).run("diagram", "draw", input, { model: "test/model" });
      const events = yield* (yield* EventBus).history;
      const output = events.find(
        (event) => event.type === "diagram/diagram.rendered" && event.run === result.run,
      );
      return {
        ok: result.ok,
        data: output?.data as Record<string, any> | undefined,
        requests: yield* Ref.get(seen),
      };
    }).pipe(Effect.provide(runtime(root, { dirs: [dir], packs }, models)));
  }).pipe(Effect.scoped);

const overlap: Found = { fatal: false, message: 'texts "Day" and "Dusk" overlap' };

describe("diagram", () => {
  test(
    "the brief names type, title and theme; the instructions carry the knowledge and the render contract; a legibility problem is repaired once",
    () =>
      Effect.gen(function* () {
        const { ok, data, requests } = yield* draw(
          { description: "Day, dusk, night, dawn.", kind: "loop", title: "Solstice" },
          [
            `A loop of four phases.\n\n\`\`\`svg\n${svg("first")}\n\`\`\``,
            `A loop of four phases, labels spread.\n\`\`\`svg\n${svg("second")}\n\`\`\``,
          ],
          { first: [overlap] },
        );
        expect(ok).toBe(true);
        expect(requests.length).toBe(2);
        expect(requests[0]!.prompt).toContain("Type: Loop (the request names kind loop)");
        expect(requests[0]!.prompt).toContain('Title: "Solstice" (use it exactly)');
        expect(requests[0]!.prompt).toContain("Theme: dark");
        for (const heading of [
          "You are Isaac's diagram designer",
          "## Connector rules (mandatory)",
          "## Dark `<defs>`",
          "## Loop (kind `loop`)",
          "## Reply and render check",
        ]) {
          expect(requests[0]!.system).toContain(heading);
        }
        expect(requests[1]!.prompt).toContain(`- ${overlap.message}`);
        expect(requests[1]!.prompt).toContain("<text>first</text>");
        expect(data!["image"]).toEndWith("/diagram-2.png");
        expect(data!["svg"]).toEndWith("/diagram-2.svg");
        expect(data!["source"]).toContain("fonts.googleapis.com");
        expect(data!["summary"]).toBe("A loop of four phases, labels spread.");
        expect(data!["theme"]).toBe("dark");
        expect(data!["attempts"]).toBe(2);
        expect(data!["warnings"]).toBeUndefined();
        expect(data!["brief"]).toBeUndefined();
      }).pipe(Effect.runPromise),
    20_000,
  );

  test(
    "after the repair, legibility leftovers ship as warnings; a repair that breaks the SVG falls back to the first render",
    () =>
      Effect.gen(function* () {
        const stuck = yield* draw(
          { description: "x", theme: "light" },
          [`One.\n${svg("first")}`, `Two.\n${svg("again first")}`],
          { first: [overlap] },
        );
        expect(stuck.ok).toBe(true);
        expect(stuck.data!["image"]).toEndWith("/diagram-2.png");
        expect(stuck.data!["theme"]).toBe("light");
        expect(stuck.data!["warnings"]).toEqual([overlap.message]);

        const broken = yield* draw(
          { description: "x" },
          [`One.\n${svg("first")}`, "Sorry, here it is in words."],
          { first: [overlap] },
        );
        expect(broken.ok).toBe(true);
        expect(broken.data!["image"]).toEndWith("/diagram-1.png");
        expect(broken.data!["summary"]).toBe("One.");
        expect(broken.data!["warnings"]).toEqual([overlap.message]);
      }).pipe(Effect.runPromise),
    20_000,
  );

  test(
    "no usable render after the repair fails the run",
    () =>
      Effect.gen(function* () {
        const never = yield* draw({ description: "x" }, ["No diagram today."], {});
        expect(never.ok).toBe(false);
        expect(never.data).toBeUndefined();
        expect(never.requests.length).toBe(2);
        expect(never.requests[1]!.prompt).toContain("the reply has no <svg>...</svg>");

        const blank = yield* draw({ description: "x" }, [svg("blank")], {
          blank: [{ fatal: true, message: "the render is blank" }],
        });
        expect(blank.ok).toBe(false);
      }).pipe(Effect.runPromise),
    20_000,
  );

  test("extractSvg takes the fenced block or the bare svg; standalone adds the namespace and imports the fonts once, after title and desc", () => {
    expect(extractSvg("Here.\n```svg\n<svg viewBox='0 0 1 1'></svg>\n```\nbye")).toBe(
      "<svg viewBox='0 0 1 1'></svg>",
    );
    expect(extractSvg("Here: <svg viewBox='0 0 1 1'><g/></svg> done")).toBe(
      "<svg viewBox='0 0 1 1'><g/></svg>",
    );
    expect(extractSvg("no diagram")).toBeUndefined();
    const out = standalone('<svg viewBox="0 0 1 1"><title>T</title><desc>D</desc><rect/></svg>');
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox')).toBe(true);
    expect(out.indexOf("@import")).toBeGreaterThan(out.indexOf("</desc>"));
    expect(out).toContain("&amp;family=Geist");
    expect(standalone(out)).toBe(out);
  });

  // Real headless Chromium: the knowledge's own examples pass the check it teaches, and every defect it names is caught.
  test(
    "the knowledge examples render clean; a defective SVG is caught on every count",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const renderer = yield* Renderer;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "diagram-test-" });
        const style = yield* fs.readFileString(`${KNOWLEDGE}style.md`);
        const examples = yield* fs.readFileString(`${KNOWLEDGE}examples.md`);
        const defs = (theme: string) =>
          new RegExp(
            `## ${theme} \`<defs>\` \\(copy verbatim\\)\\s+\`\`\`svg\\n([\\s\\S]*?)\`\`\``,
          ).exec(style)![1]!;
        const blocks = [...examples.matchAll(/```svg\n([\s\S]*?)```/g)].map((match) => match[1]!);
        expect(blocks.length).toBe(2);
        for (const [index, block] of blocks.entries()) {
          const theme = block.includes("<!-- light defs -->") ? "light" : "dark";
          const source = standalone(
            block
              .replace("<!-- dark defs -->", defs("Dark"))
              .replace("<!-- light defs -->", defs("Light"))
              .trim(),
          );
          const rendered = yield* renderer.render(source, theme, `${dir}/example-${index}.png`);
          expect(rendered.problems).toEqual([]);
          expect((yield* fs.stat(`${dir}/example-${index}.png`)).size).toBeGreaterThan(20_000n);
        }

        const defective = [
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400">',
          '<rect width="800" height="400" fill="#2d3142"/>',
          '<text x="40" y="60" fill="#f5f5f5" font-size="14">Overlapping label one</text>',
          '<text x="44" y="62" fill="#f5f5f5" font-size="14">Overlapping label two</text>',
          '<text x="40" y="120" fill="#f5f5f5" font-size="5">tiny</text>',
          '<text x="760" y="160" fill="#f5f5f5" font-size="14">past the edge here</text>',
          '<text x="40" y="200" fill="#3a3f52" font-size="14">low contrast</text>',
          '<rect x="40" y="240" width="60" height="40" fill="#393e53"/>',
          '<text x="44" y="264" fill="#f5f5f5" font-size="12">far too long for its box</text>',
          '<line x1="300" y1="300" x2="500" y2="300" stroke="#bfc0c0" marker-end="url(#nope)"/>',
          '<text x="600" y="300" fill="#f5f5f5" font-size="40" opacity="0.06">01</text>',
          "</svg>",
        ].join("");
        const caught = (yield* renderer.render(defective, "dark", `${dir}/defective.png`)).problems
          .map((problem) => problem.message)
          .join("\n");
        for (const expected of [
          "<title>",
          "<desc>",
          "url(#nope)",
          '"tiny" is 5px',
          '"past the edge here" runs',
          '"low contrast" has contrast',
          '"far too long for its box" spills',
          '"Overlapping label one" and "Overlapping label two" overlap',
        ]) {
          expect(caught).toContain(expected);
        }
        expect(caught).not.toContain('"01"');

        const broken = yield* renderer.render(
          '<svg viewBox="0 0 800 400"><text>a & b</text></svg>',
          "dark",
          `${dir}/broken.png`,
        );
        expect(broken.png).toBeUndefined();
        expect(broken.problems[0]!.fatal).toBe(true);
        expect(broken.problems[0]!.message).toContain("not well-formed XML");
      }).pipe(
        Effect.scoped,
        Effect.provide(Renderer.layer),
        Effect.provide(BunServices.layer),
        Effect.runPromise,
      ),
    60_000,
  );
});
