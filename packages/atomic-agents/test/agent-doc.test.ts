import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Ref, Schema } from "effect";
import { pack } from "../src/core/Adapter.ts";
import { Agents, parseAgent } from "../src/core/Agent.ts";
import { EventBus } from "../src/core/Event.ts";
import { type GenerateRequest, ModelRunner } from "../src/core/Model.ts";
import { Runner } from "../src/core/Runtime.ts";
import { packs as defaultPacks } from "../src/packs.ts";
import { oneProcess, runtime, tempHome } from "./harness.ts";

/** Request, reply and answer typed in code, registered by name the way a domain's `schema.ts` is. */
const greetPack = pack({
  name: "greet",
  layer: Layer.empty,
  schemas: {
    "greet.asked": Schema.Struct({
      requestId: Schema.optionalKey(Schema.NonEmptyString),
      name: Schema.NonEmptyString,
    }),
    "greet.answered": Schema.Struct({
      requestId: Schema.optionalKey(Schema.NonEmptyString),
      greeting: Schema.String,
      model: Schema.String,
    }),
    "greet.answer": Schema.Struct({ greeting: Schema.String }),
  },
});
const packs = [...defaultPacks, greetPack];

const front = [
  "id: greeter",
  "purpose: Greet whoever is named.",
  "model: test/m",
  "candidates: [test/m]",
  "request: greet.asked",
  "reply: greet.answered",
  "show: greeting",
  "job: greet",
  "description: Greet the name.",
  'prompt: "Greet {{name}}."',
  "answer: greet.answer",
];
const doc = (lines: ReadonlyArray<string>, body = "You greet people warmly.") =>
  `---\n${lines.join("\n")}\n---\n\n${body}\n`;

/** An agent folder `<root>/agents/<folder>/` with this AGENT.md and knowledge files. */
const folder = (
  root: string,
  name: string,
  text: string,
  knowledge: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${root}/agents/${name}`;
    yield* fs.makeDirectory(`${dir}/knowledge`, { recursive: true });
    yield* fs.writeFileString(`${dir}/AGENT.md`, text);
    for (const [file, content] of Object.entries(knowledge))
      yield* fs.writeFileString(`${dir}/knowledge/${file}`, content);
    return `${dir}/AGENT.md`;
  });

const rejection = (root: string, file: string, text: string) =>
  parseAgent(file, text).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
    Effect.provide(oneProcess(root, { packs })),
  );

describe("agent folders (AGENT.md)", () => {
  test("a folder loads beside the files: the body is the instructions, every knowledge file follows in name order, request and reply resolve to the code schemas, and it answers as an ask pair", () =>
    Effect.gen(function* () {
      const root = yield* tempHome;
      yield* folder(root, "greeter", doc(front), {
        "b-tone.md": "Tone: warm.",
        "a-names.md": "Use first names.",
      });
      const seen = yield* Ref.make<ReadonlyArray<GenerateRequest>>([]);
      const models = ModelRunner.of({
        generate: (request) =>
          Ref.update(seen, (all) => [...all, request]).pipe(
            Effect.as({
              text: JSON.stringify({ answer: { greeting: "Hi Ada" } }),
              model: request.model,
              provider: "test",
              seconds: 0,
              cost: 0,
            }),
          ),
      });
      yield* Effect.gen(function* () {
        const agent = (yield* (yield* Agents).current).find(
          (candidate) => candidate.id === "greeter",
        )!;
        expect(agent.file).toEndWith("/agents/greeter/AGENT.md");
        expect(agent.asks?.request).toBe("greet.asked");
        const result = yield* (yield* Runner).run("greeter", "greet", { name: "Ada" }, {});
        expect(result.ok).toBe(true);
        const reply = (yield* (yield* EventBus).history).find(
          (event) => event.type === "greeter/greet.answered",
        );
        expect(reply?.data).toMatchObject({ greeting: "Hi Ada", model: "test/m" });
        const [request] = yield* Ref.get(seen);
        expect(request!.prompt).toContain("Greet Ada.");
        expect(request!.system.indexOf("You greet people warmly.")).toBeLessThan(
          request!.system.indexOf("Use first names."),
        );
        expect(request!.system.indexOf("Use first names.")).toBeLessThan(
          request!.system.indexOf("Tone: warm."),
        );
      }).pipe(Effect.provide(runtime(root, { dirs: [`${root}/agents`], packs }, models)));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));

  test("what keeps a folder from loading: no frontmatter, an id that is not the folder's, knowledge outside the folder, an unknown schema, a misspelled key", () =>
    Effect.gen(function* () {
      const root = yield* tempHome;
      const file = yield* folder(root, "greeter", doc(front));
      expect(yield* rejection(root, file, "You greet people.")).toContain(
        "starts with no YAML frontmatter",
      );
      expect(yield* rejection(root, file, doc(front, ""))).toContain(
        "has no instructions after the frontmatter",
      );
      expect(
        yield* rejection(
          root,
          file,
          doc(front.map((line) => line.replace("id: greeter", "id: welcomer"))),
        ),
      ).toContain("id welcomer must match the folder name (greeter)");
      expect(
        yield* rejection(root, file, doc([...front, "knowledge: [../../secrets.md]"])),
      ).toContain("knowledge: ../../secrets.md is not a file name");
      expect(yield* rejection(root, file, doc([...front, "knowledge: [missing.md]"]))).toContain(
        "knowledge/missing.md does not exist",
      );
      expect(
        yield* rejection(
          root,
          file,
          doc(front.map((line) => line.replace("reply: greet.answered", "reply: greet.anwsered"))),
        ),
      ).toContain('events.greet.anwsered: no schema "greet.anwsered" (have: ');
      expect(yield* rejection(root, file, doc([...front, "modle: test/x"]))).toContain("modle");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));
});
