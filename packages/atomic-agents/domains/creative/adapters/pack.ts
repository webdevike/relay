import { Effect, Layer, Schema } from "effect";
import { pack } from "../../../src/core/Adapter.ts";
import {
  CreativeRequested,
  DEFAULT_COUNT,
  type CreativeOption,
  type Kind,
  schemas,
} from "../schema.ts";
import { render, roll, seedKindOf, systemRng, type Rng } from "./seed.ts";

export class CreativeError extends Schema.TaggedError<CreativeError>()("CreativeError", {
  message: Schema.String,
}) {}

/** Context under this many characters is thin: the brief carries no world to start from, so each option starts from a seed. */
export const THIN_CONTEXT = 200;

const WHAT: Readonly<Record<Kind, string>> = {
  name: "Names: a name for the thing in the brief. Each option is the name alone (with its meaning or sound in the `why`).",
  copy: "Copy: wording, such as a headline, a tagline or a short text, at the length the brief sets. Each option is the finished text.",
  concept:
    "Concepts: an idea, a mechanic or an angle. Each option is a concrete idea in a few sentences: who does what, and what pushes back.",
  "visual-direction":
    "Visual directions: a look a designer could build. Each option is one direction written in a few sentences: the method it looks made by, the one strong decision that leads, palette, layout and type as the brief needs. Words, not an image.",
};

const decodeRequest = Schema.decodeUnknownEffect(CreativeRequested);

/** The model's brief for one request, and the seeds when the context is thin. */
export const ask = (request: typeof CreativeRequested.Type, rng: Rng = systemRng): string => {
  const wanted = request.count ?? DEFAULT_COUNT;
  const context = request.context?.trim() ?? "";
  const thin = context.length < THIN_CONTEXT;
  const kind = seedKindOf(request.kind);
  return [
    `Make ${wanted} option${wanted === 1 ? "" : "s"}.`,
    "",
    `Kind: ${request.kind}. ${WHAT[request.kind]}`,
    "",
    "Brief:",
    request.brief.trim(),
    "",
    "Project context:",
    context === "" ? "none given" : context,
    "",
    "Start point:",
    thin
      ? [
          `The context is thin, so each option starts from its own seed (a start point from outside your taste; roll, tie it to the subject with a reason, and drop an axis that fights the subject).`,
          ...Array.from({ length: wanted }, (_, index) =>
            [`Seed for option ${index + 1}:`, render(roll(kind, rng))].join("\n"),
          ),
        ].join("\n\n")
      : "The context is real. Start every option from a fact in it. No seed.",
  ].join("\n");
};

/** The contract the check enforces, placed in the agent's instructions by `{{check}}`. */
export const CONTRACT = [
  "## Reply and check",
  "",
  'Reply with one JSON object and nothing else: `{"options": [{"option": "...", "avoided": "...", "why": "..."}], "pick": 1, "pickWhy": "..."}`.',
  "",
  "- `options` holds exactly the number asked for. `option` is the work itself. `avoided` is the obvious or average pick you moved away from, in one line (never the option itself). `why` is one sentence naming a fact about this project.",
  "- `pick` is the 1-based number of the option you recommend; `pickWhy` says why in one or two sentences.",
  "- Options differ in kind, not in wording: no two share a main move, and no option is only a variation of another.",
  "- For copy, no exclamation mark.",
  "- Write the text of every field in the language of the brief.",
  "",
  "The reply is parsed as JSON and goes back to you once, with the list, when it is not valid JSON, has the wrong number of options, an empty field, an option equal to its own `avoided`, two options that are the same, a `pick` outside the list, or an exclamation mark in copy.",
].join("\n");

const FENCED = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/;

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const same = (a: string, b: string) =>
  a
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim() ===
  b
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** What a reply holds, or every way it fails the contract. */
export const parseOptions = (
  reply: string,
  wanted: number,
  kind: Kind,
):
  | {
      readonly ok: true;
      readonly options: ReadonlyArray<CreativeOption>;
      readonly pick: number;
      readonly pickWhy: string;
    }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> } => {
  const body = FENCED.exec(reply)?.[1] ?? reply;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed =
      start >= 0 && end > start ? asObject(JSON.parse(body.slice(start, end + 1))) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) return { ok: false, problems: ["the reply is not one JSON object"] };
  const raw = Array.isArray(parsed["options"]) ? (parsed["options"] as ReadonlyArray<unknown>) : [];
  const problems: string[] = [];
  if (raw.length !== wanted) problems.push(`${raw.length} options, ${wanted} asked for`);
  const options = raw.map((item): CreativeOption => {
    const row = asObject(item) ?? {};
    return { option: text(row["option"]), avoided: text(row["avoided"]), why: text(row["why"]) };
  });
  options.forEach((row, index) => {
    const at = `option ${index + 1}`;
    for (const field of ["option", "avoided", "why"] as const)
      if (row[field] === "") problems.push(`${at}: \`${field}\` is empty`);
    if (row.option !== "" && same(row.option, row.avoided))
      problems.push(`${at}: it is its own \`avoided\`; name the obvious pick it moved away from`);
    if (kind === "copy" && row.option.includes("!"))
      problems.push(`${at}: an exclamation mark in copy`);
    for (let before = 0; before < index; before += 1)
      if (row.option !== "" && same(row.option, options[before]!.option))
        problems.push(`${at} repeats option ${before + 1}`);
  });
  const pick = parsed["pick"];
  if (typeof pick !== "number" || !Number.isInteger(pick) || pick < 1 || pick > wanted)
    problems.push(`\`pick\` must be a whole number from 1 to ${wanted}`);
  const pickWhy = text(parsed["pickWhy"]);
  if (pickWhy === "") problems.push("`pickWhy` is empty");
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, options, pick: pick as number, pickWhy };
};

/** The options as Markdown: what `agents_ask` shows. */
export const markdown = (
  options: ReadonlyArray<CreativeOption>,
  pick: number,
  pickWhy: string,
): string =>
  [
    ...options.flatMap((row, index) => [
      `${index + 1}. ${row.option}${index + 1 === pick ? " (pick)" : ""}`,
      `   - moved away from: ${row.avoided}`,
      `   - why here: ${row.why}`,
    ]),
    "",
    `Pick ${pick}: ${pickWhy}`,
  ].join("\n");

const wantedOf = (fields: Readonly<Record<string, unknown>>): number => {
  const count = fields["count"];
  return typeof count === "number" ? count : DEFAULT_COUNT;
};

/** The creative adapters: the `creative.brief` step (the request as the model's brief, seeds from `rng` when the context is thin) and the `creative.options` check. */
export const creativePack = (rng: Rng = systemRng) =>
  pack({
    name: "creative",
    layer: Layer.empty,
    schemas,
    steps: [
      {
        name: "creative.brief",
        description: `Turns a creative.requested into the model's brief: the kind, the brief, the project context, the count (default ${DEFAULT_COUNT}) and, when the context is under ${THIN_CONTEXT} characters, one random seed per option (the antialgorithm pools). Provides ask.`,
        provides: ["ask"],
        run: (fields) =>
          Effect.gen(function* () {
            const request = yield* decodeRequest(fields).pipe(
              Effect.mapError(
                (error) => new CreativeError({ message: `request: ${error.message}` }),
              ),
            );
            return { ask: ask(request, rng) };
          }),
      },
    ],
    checks: [
      {
        name: "creative.options",
        description:
          "The reply is one JSON object of options, each with the obvious pick it moved away from and why it fits the project, plus a pick. Provides options, pick, pickWhy and text. Any problem gets one repair turn with the list; a reply still failing after it fails the run.",
        provides: ["options", "pick", "pickWhy", "text"],
        contract: CONTRACT,
        check: (reply, context) =>
          Effect.gen(function* () {
            const wanted = wantedOf(context.fields);
            const kind = context.fields["kind"] as Kind;
            const parsed = parseOptions(reply.text, wanted, kind);
            if (parsed.ok)
              return {
                pass: true as const,
                fields: {
                  options: parsed.options,
                  pick: parsed.pick,
                  pickWhy: parsed.pickWhy,
                  text: markdown(parsed.options, parsed.pick, parsed.pickWhy),
                },
              };
            return {
              pass: false as const,
              repair: [
                context.prompt,
                "",
                "Your previous reply failed the check:",
                ...parsed.problems.map((problem) => `- ${problem}`),
                "",
                "Your reply:",
                reply.text,
                "",
                `Fix every problem and reply again with the one JSON object: exactly ${wanted} option${wanted === 1 ? "" : "s"}.`,
              ].join("\n"),
              giveUp: Effect.fail(new CreativeError({ message: parsed.problems.join("; ") })),
            };
          }),
      },
    ],
  });
