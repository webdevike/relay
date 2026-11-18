import { homedir } from "node:os";
import { Config, Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { pack } from "../../../src/core/Adapter.ts";
import { moduleFile, type ToolsError } from "../../../src/core/Component.ts";
import { exec } from "../../../src/core/exec.ts";
import { RenderRequested, schemas } from "../schema.ts";

export class BlenderError extends Schema.TaggedError<BlenderError>()("BlenderError", {
  message: Schema.String,
  log: Schema.String,
}) {}

export class ReferenceError extends Schema.TaggedError<ReferenceError>()("ReferenceError", {
  message: Schema.String,
}) {}

/** Run a geometry-only build() script, export the model as GLB, render it on the fixed stage (floor, three lights, auto-framed camera at the script's VIEW). */
export class Blender extends Context.Service<
  Blender,
  {
    render(script: string, image: string, glb: string): Effect.Effect<void, BlenderError>;
  }
>()("atomic-agents/blender/Blender") {
  static readonly layer = Layer.effect(
    Blender,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const binary = yield* Config.String("BLENDER").pipe(Config.withDefault("blender"));
      const stage = yield* moduleFile(import.meta.url, "./stage.py");
      const render = Effect.fn("Blender.render")(
        function* (script: string, image: string, glb: string) {
          const result = yield* exec(binary, [
            "-b",
            "--factory-startup",
            "-noaudio",
            "--python-exit-code",
            "1",
            "--python",
            stage,
            "--",
            script,
            image,
            glb,
          ]).pipe(
            Effect.timeoutOrElse({
              duration: "3 minutes",
              orElse: () => Effect.fail(new BlenderError({ message: "render timed out", log: "" })),
            }),
            Effect.catchTag("PlatformError", (error) =>
              Effect.fail(new BlenderError({ message: error.message, log: "" })),
            ),
          );
          if (result.exitCode !== 0) {
            const output = `${result.stdout}\n${result.stderr}`;
            const marker = output.indexOf("STAGE_ERROR");
            const log = (marker >= 0 ? output.slice(marker + "STAGE_ERROR".length) : output)
              .trim()
              .slice(-2500);
            return yield* new BlenderError({
              message: log.split("\n").at(-1) ?? "blender failed",
              log,
            });
          }
        },
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      return Blender.of({ render });
    }),
  );
}

const DROP = /^\/drops\/[^/]+\/[^/]+$/;

/** An image file's extension by its magic bytes (PNG, JPEG, WebP, GIF); undefined for anything else. */
export const imageExtension = (bytes: Uint8Array): string | undefined => {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(0, 4) === "GIF8") return "gif";
  return undefined;
};

const decodeServeInfo = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ port: Schema.Int })),
);

/**
 * The running Relay host's loopback URL, resolved per call as `relay share` does: `$RELAY_HOST_URL`, else the port
 * `relay-linux serve` left in `$XDG_CONFIG_HOME/relay/serve.json` (default `~/.config`).
 */
const hostUrl = Effect.gen(function* () {
  const override = process.env["RELAY_HOST_URL"]?.trim();
  if (override !== undefined && override !== "") return override.replace(/\/+$/, "");
  const path = yield* Path.Path;
  const base = process.env["XDG_CONFIG_HOME"] ?? path.join(homedir(), ".config");
  const info = yield* decodeServeInfo(
    yield* (yield* FileSystem.FileSystem).readFileString(path.join(base, "relay", "serve.json")),
  );
  return `http://127.0.0.1:${info.port}`;
});

const download = (url: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    catch: (error) =>
      new Error(`${url}: ${error instanceof Error ? error.message : String(error)}`),
  });

/** The reference image's bytes: a local file, a Relay drop (fetched from the running host) or an http(s) URL. */
const referenceBytes = (reference: string) =>
  Effect.gen(function* () {
    if (/^https?:\/\//.test(reference)) return yield* download(reference);
    if (DROP.test(reference)) return yield* download(`${yield* hostUrl}${reference}`);
    const path = yield* Path.Path;
    if (!path.isAbsolute(reference))
      return yield* Effect.fail(
        new Error("not an absolute path, a /drops/<id>/<token> path or an http(s) URL"),
      );
    return yield* (yield* FileSystem.FileSystem).readFile(reference);
  }).pipe(
    Effect.mapError(
      (error) =>
        new ReferenceError({
          message: `reference ${reference}: ${error instanceof Error ? error.message : String(error)}`,
        }),
    ),
  );

const decodeRequest = Schema.decodeUnknownEffect(RenderRequested);

/** The render adapters over `layer` (headless Blender, or a test fake). */
export const blenderPack = (layer: Layer.Layer<Blender, ToolsError, BunServices> = Blender.layer) =>
  pack({
    name: "blender",
    layer,
    schemas,
    steps: [
      {
        name: "render.reference",
        description:
          "Turns a render.requested into the model's brief. With a reference (absolute path, /drops/<id>/<token> on the running Relay host, or http(s) URL), copies the image into the run dir as reference.<ext> for the model to see and asks it to match the image and its camera angle. Provides brief and referenceImage (absent without a reference).",
        provides: ["brief", "referenceImage"],
        run: (fields, context) =>
          Effect.gen(function* () {
            const request = yield* decodeRequest(fields).pipe(
              Effect.mapError(
                (error) => new ReferenceError({ message: `request: ${error.message}` }),
              ),
            );
            const subject = `Model this object: ${request.subject}`;
            if (request.reference === undefined) return { brief: subject };
            const bytes = yield* referenceBytes(request.reference);
            const extension = imageExtension(bytes);
            if (extension === undefined)
              return yield* new ReferenceError({
                message: `reference ${request.reference}: not a PNG, JPEG, WebP or GIF image`,
              });
            const path = yield* Path.Path;
            const referenceImage = path.join(context.runDir, `reference.${extension}`);
            yield* (yield* FileSystem.FileSystem)
              .writeFile(referenceImage, bytes)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new ReferenceError({ message: `write ${referenceImage}: ${error.message}` }),
                ),
              );
            const brief = [
              subject,
              "",
              "The attached image is the reference. Build the model to match it: the same silhouette, proportions and part layout, the same materials and colors. Set VIEW to the angle the reference is seen from.",
            ].join("\n");
            return { brief, referenceImage };
          }),
      },
    ],
    checks: [
      {
        name: "blender.render",
        description:
          "The reply is a Blender Python build() script (fenced or bare); it must run in headless Blender on the stage. Provides image (768x768 PNG), glb (the bare model) and script, all in the run dir. A failing script goes back once with Blender's traceback; failing again fails the run.",
        provides: ["image", "glb", "script"],
        check: (reply, context) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const image = path.join(context.runDir, "render.png");
            const glb = path.join(context.runDir, "model.glb");
            const code = /```(?:python|py)?\n([\s\S]*?)```/.exec(reply.text)?.[1] ?? reply.text;
            const script = path.join(context.runDir, `build-${context.attempt}.py`);
            yield* fs
              .writeFileString(script, code)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new BlenderError({ message: `write ${script}: ${error.message}`, log: "" }),
                ),
              );
            const outcome = yield* Effect.result((yield* Blender).render(script, image, glb));
            if (outcome._tag === "Success")
              return { pass: true as const, fields: { image, glb, script } };
            return {
              pass: false as const,
              // One repair turn: the agent sees its own script and Blender's traceback.
              repair: `${context.prompt}\n\nYour previous script failed in Blender:\n\`\`\`python\n${code}\n\`\`\`\nError:\n${outcome.failure.log}\n\nReturn the corrected script.`,
              giveUp: Effect.fail(outcome.failure),
            };
          }),
      },
    ],
  });
