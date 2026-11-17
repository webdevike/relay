import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { pack } from "../../../src/core/Adapter.ts";
import type { ToolsError } from "../../../src/core/Component.ts";
import { DiagramRequested, type Kind, schemas, type Theme } from "../schema.ts";
import type { Found } from "./page.ts";
import { FONTS, LIMITS, RenderError, Renderer, SCALE } from "./renderer.ts";

const TYPE: Readonly<Record<Kind, string>> = {
  flow: "Flowchart",
  loop: "Loop",
  sequence: "Sequence",
  architecture: "Architecture",
  state: "State machine",
  timeline: "Timeline",
};

const FENCED = /```(?:svg|xml|html)?[ \t]*\r?\n([\s\S]*?)```/;

/** The SVG in a reply: the fenced block's, else the bare `<svg ...>...</svg>`. */
export const extractSvg = (text: string): string | undefined => {
  const body = FENCED.exec(text)?.[1] ?? text;
  const start = body.indexOf("<svg");
  const end = body.lastIndexOf("</svg>");
  return start >= 0 && end > start ? body.slice(start, end + "</svg>".length) : undefined;
};

/** The reply's words around the SVG (the model's summary), else the SVG's `<desc>`. */
export const summaryOf = (text: string, svg: string): string => {
  const fenced = FENCED.exec(text);
  const rest = fenced === null ? text.replace(svg, "") : text.replace(fenced[0], "");
  const words = rest.replace(/\s+/g, " ").trim();
  if (words !== "") return words.slice(0, 800);
  return (/<desc[^>]*>([\s\S]*?)<\/desc>/.exec(svg)?.[1] ?? "").replace(/\s+/g, " ").trim();
};

/** The SVG as a standalone file: the SVG namespace, and the design system's fonts imported after `<title>` and `<desc>` (which stay first). */
export const standalone = (svg: string): string => {
  const named = /^<svg\b[^>]*\bxmlns=/.test(svg)
    ? svg
    : svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (named.includes("fonts.googleapis.com")) return named;
  const style = `<style>@import url('${FONTS.replaceAll("&", "&amp;")}');</style>`;
  for (const anchor of ["</desc>", "</title>"]) {
    const at = named.indexOf(anchor);
    if (at >= 0)
      return `${named.slice(0, at + anchor.length)}\n  ${style}${named.slice(at + anchor.length)}`;
  }
  const open = named.indexOf(">") + 1;
  return `${named.slice(0, open)}\n  ${style}${named.slice(open)}`;
};

/** The contract the render check enforces, placed in the agent's instructions by `{{check}}`. */
export const CONTRACT = [
  "## Reply and render check",
  "",
  "Reply with one or two plain sentences (the type you drew and what you merged or left out), then the whole SVG in one ```svg block, and nothing after it.",
  "",
  `The SVG is parsed as XML, put on the theme's paper with Instrument Serif, Geist and Geist Mono loaded, rendered at its viewBox size and shot at ${SCALE}x to PNG, then measured. It goes back to you once, with the list, when any of these hold:`,
  "",
  `- It is not well-formed XML (escape & and < in text as &amp; and &lt;), has no viewBox, or the viewBox is outside ${LIMITS.minWidth} to ${LIMITS.maxWidth} wide or ${LIMITS.minHeight} to ${LIMITS.maxHeight} tall.`,
  `- It has fewer than ${LIMITS.minTexts} text labels, or renders blank.`,
  `- A text is under ${LIMITS.minFont}px, runs past the canvas edge, covers more than ${LIMITS.overlap * 100}% of another text, spills sideways more than ${LIMITS.slack}px out of the rect it sits on, or has under ${LIMITS.minContrast}:1 contrast with what is painted under it. Text under ${LIMITS.decorativeAlpha * 100}% opacity is decoration and is not measured.`,
  "- A url(#id) points to nothing, the <title> is not the first child, the <desc> is missing, or nothing paints the canvas corner.",
].join("\n");

/** One render's outcome, kept in the run dir so the repair's check can fall back to it. */
const Outcome = Schema.Struct({
  fields: Schema.Record(Schema.String, Schema.Unknown),
  problems: Schema.Array(Schema.Struct({ fatal: Schema.Boolean, message: Schema.String })),
});
const decodeOutcome = Schema.decodeUnknownOption(Schema.fromJsonString(Outcome));

const decodeRequest = Schema.decodeUnknownEffect(DiagramRequested);

/** The diagram adapters over `layer` (headless Chromium, or a test fake). */
export const diagramPack = (
  layer: Layer.Layer<Renderer, ToolsError, BunServices> = Renderer.layer,
) =>
  pack({
    name: "diagram",
    layer,
    schemas,
    steps: [
      {
        name: "diagram.brief",
        description:
          "Turns a diagram.requested into the model's brief (the description, the type to draw or that it picks, the title, the theme) and resolves theme (default dark). Provides brief and theme.",
        provides: ["brief", "theme"],
        run: (fields) =>
          Effect.gen(function* () {
            const request = yield* decodeRequest(fields).pipe(
              Effect.mapError((error) => new RenderError({ message: `request: ${error.message}` })),
            );
            const theme: Theme = request.theme ?? "dark";
            const brief = [
              "Draw this as one diagram.",
              "",
              "Description:",
              request.description,
              "",
              `Type: ${request.kind === undefined ? "not named, choose the one that fits" : `${TYPE[request.kind]} (the request names kind ${request.kind})`}`,
              `Title: ${request.title === undefined ? "not given, write a short one" : `"${request.title}" (use it exactly)`}`,
              `Theme: ${theme} (copy the ${theme} <defs> block)`,
            ].join("\n");
            return { brief, theme };
          }),
      },
    ],
    checks: [
      {
        name: "diagram.render",
        description: `The reply is a summary plus one SVG; it is rendered in headless Chromium at ${SCALE}x and measured (well-formed, framed, non-blank, text legible). Provides image (PNG), svg (standalone file), source, summary, width, height, theme (the one drawn on), and warnings (legibility problems the repair left). Any problem gets one repair turn with the list; after it, a render that is not usable fails the run unless the first one was, and legibility leftovers ship as warnings.`,
        provides: ["image", "svg", "source", "summary", "width", "height", "theme", "warnings"],
        contract: CONTRACT,
        check: (reply, context) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const theme: Theme = context.fields["theme"] === "light" ? "light" : "dark";
            const record = path.join(context.runDir, `diagram-${context.attempt}.json`);
            const fallback = Effect.gen(function* () {
              const first = decodeOutcome(
                yield* fs
                  .readFileString(path.join(context.runDir, "diagram-1.json"))
                  .pipe(Effect.orElseSucceed(() => "")),
              );
              return first._tag === "Some" &&
                first.value.problems.every((problem) => !problem.fatal)
                ? first.value
                : undefined;
            });
            const verdict = (
              problems: ReadonlyArray<Found>,
              fields: Readonly<Record<string, unknown>> | undefined,
              source: string | undefined,
            ) =>
              Effect.gen(function* () {
                if (fields !== undefined)
                  yield* fs
                    .writeFileString(record, JSON.stringify({ fields, problems }))
                    .pipe(Effect.orElseSucceed(() => undefined));
                const fatal = problems.filter((problem) => problem.fatal);
                // After the repair a usable render ships, its leftovers as warnings.
                if (
                  fields !== undefined &&
                  (problems.length === 0 || (context.attempt > 1 && fatal.length === 0))
                ) {
                  return {
                    pass: true as const,
                    fields:
                      problems.length === 0
                        ? fields
                        : { ...fields, warnings: problems.map((problem) => problem.message) },
                  };
                }
                return {
                  pass: false as const,
                  repair: [
                    context.prompt,
                    "",
                    "Your previous diagram failed the render check:",
                    ...problems.map((problem) => `- ${problem.message}`),
                    ...(source === undefined ? [] : ["", "Your SVG:", "```svg", source, "```"]),
                    "",
                    "Fix every problem and reply again the same way: the summary, then the whole corrected SVG in one svg block.",
                  ].join("\n"),
                  giveUp: Effect.gen(function* () {
                    const first = yield* fallback;
                    if (first === undefined)
                      return yield* new RenderError({
                        message: problems.map((problem) => problem.message).join("; "),
                      });
                    return first.problems.length === 0
                      ? first.fields
                      : {
                          ...first.fields,
                          warnings: first.problems.map((problem) => problem.message),
                        };
                  }),
                };
              });

            const svg = extractSvg(reply.text);
            if (svg === undefined)
              return yield* verdict(
                [{ fatal: true, message: "the reply has no <svg>...</svg>" }],
                undefined,
                undefined,
              );
            const source = standalone(svg);
            const file = path.join(context.runDir, `diagram-${context.attempt}.svg`);
            const image = path.join(context.runDir, `diagram-${context.attempt}.png`);
            yield* fs
              .writeFileString(file, `${source}\n`)
              .pipe(
                Effect.mapError(
                  (error) => new RenderError({ message: `write ${file}: ${error.message}` }),
                ),
              );
            const rendered = yield* (yield* Renderer).render(source, theme, image);
            const fields =
              rendered.png === undefined
                ? undefined
                : {
                    image: rendered.png,
                    svg: file,
                    source,
                    summary: summaryOf(reply.text, svg),
                    width: rendered.width,
                    height: rendered.height,
                    theme,
                  };
            return yield* verdict(rendered.problems, fields, source);
          }),
      },
    ],
  });
