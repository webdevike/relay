import { describe, expect, test } from "bun:test";
import { Effect, Layer, Ref } from "effect";
import { packs as defaultPacks } from "../../../src/packs.ts";
import { EventBus } from "../../../src/core/Event.ts";
import { type GenerateRequest, ModelRunner } from "../../../src/core/Model.ts";
import { Runner } from "../../../src/core/Runtime.ts";
import { builtinAgents, runtime, tempHome } from "../../../test/harness.ts";
import { Blender, blenderPack } from "../index.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SCRIPT = "```python\nimport bpy\n\ndef build():\n    pass\n```";

/** Blender that never starts: every script renders. */
const fakeBlender = Layer.succeed(Blender, Blender.of({ render: () => Effect.void }));

/** Run the shipped prop-render agent once over a temp home; answer its render.completed data, the model requests and the run's error. */
const renderOnce = (input: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const root = yield* tempHome;
    const dir = yield* builtinAgents(root, ["prop-render"]);
    const seen = yield* Ref.make<ReadonlyArray<GenerateRequest>>([]);
    const models = ModelRunner.of({
      generate: (request) =>
        Ref.update(seen, (all) => [...all, request]).pipe(
          Effect.as({ text: SCRIPT, model: request.model, provider: "test", seconds: 0, cost: 0 }),
        ),
    });
    const packs = [
      ...defaultPacks.filter((candidate) => candidate.name !== "blender"),
      blenderPack(fakeBlender),
    ];
    return yield* Effect.gen(function* () {
      const result = yield* (yield* Runner).run("prop-render", "render", input, {
        model: "test/model",
      });
      const events = yield* (yield* EventBus).history;
      const output = events.find(
        (event) => event.type === "prop-render/render.completed" && event.run === result.run,
      );
      const failed = events.find(
        (event) => event.type === "prop-render/job.failed" && event.run === result.run,
      );
      const requests = yield* Ref.get(seen);
      const attached = requests[0]?.files?.[0];
      return {
        ok: result.ok,
        data: output?.data as Record<string, unknown> | undefined,
        failure: JSON.stringify(failed?.data ?? null),
        requests,
        /** The first attached file's bytes, read before the temp home goes. */
        attachedBytes:
          attached === undefined
            ? undefined
            : new Uint8Array(yield* Effect.promise(() => Bun.file(attached).arrayBuffer())),
      };
    }).pipe(Effect.provide(runtime(root, { dirs: [dir], packs }, models)));
  }).pipe(Effect.scoped);

describe("prop-render", () => {
  test(
    "without a reference the model gets the subject alone and sees no image",
    () =>
      Effect.gen(function* () {
        const { ok, data, requests } = yield* renderOnce({ subject: "a wooden chess rook" });
        expect(ok).toBe(true);
        expect(requests[0]!.prompt).toBe("Model this object: a wooden chess rook");
        expect(requests[0]!.files).toBeUndefined();
        expect(requests[0]!.system).toContain("VIEW = {");
        expect(data!["image"]).toEndWith("/render.png");
        expect(data!["reference"]).toBeUndefined();
      }).pipe(Effect.runPromise),
    20_000,
  );

  test(
    "a drop reference is fetched from the Relay host, saved by its type and shown to the model",
    () =>
      Effect.gen(function* () {
        const server = Bun.serve({
          port: 0,
          fetch: (request) =>
            new URL(request.url).pathname === "/drops/abc/tok"
              ? new Response(PNG)
              : new Response("not found", { status: 404 }),
        });
        // The step reads the host URL at run time, from the process environment.
        const previous = process.env["RELAY_HOST_URL"];
        process.env["RELAY_HOST_URL"] = `http://127.0.0.1:${server.port}/`;
        try {
          const { ok, data, failure, requests, attachedBytes } = yield* renderOnce({
            subject: "a solar battery",
            reference: "/drops/abc/tok",
          });
          expect([ok, failure]).toEqual([true, "null"]);
          expect(requests[0]!.files![0]!).toEndWith("/reference.png");
          expect(attachedBytes).toEqual(PNG);
          expect(requests[0]!.prompt).toContain("The attached image is the reference.");
          expect(data!["reference"]).toBe("/drops/abc/tok");
        } finally {
          if (previous === undefined) delete process.env["RELAY_HOST_URL"];
          else process.env["RELAY_HOST_URL"] = previous;
          server.stop(true);
        }
      }).pipe(Effect.runPromise),
    20_000,
  );

  test(
    "a reference that is not an image fails the run before any model call",
    () =>
      Effect.gen(function* () {
        const text = `${process.env["TMPDIR"] ?? "/tmp"}/prop-render-not-an-image.txt`;
        yield* Effect.promise(() => Bun.write(text, "hello"));
        const { ok, failure, requests } = yield* renderOnce({ subject: "x", reference: text });
        expect(ok).toBe(false);
        expect(failure).toContain("not a PNG, JPEG, WebP or GIF image");
        expect(requests.length).toBe(0);
      }).pipe(Effect.runPromise),
    20_000,
  );
});
