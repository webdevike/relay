import { Schema } from "effect";

/** What the options are for; each kind maps to one section of the agent's knowledge and to one seed pool (`adapters/seed.ts`). */
export const Kind = Schema.Literals(["name", "copy", "concept", "visual-direction"]);
export type Kind = typeof Kind.Type;

export const MAX_COUNT = 8;
export const DEFAULT_COUNT = 5;

/** `creative.requested`: a creative choice left open, with the project it belongs to. */
export const CreativeRequested = Schema.Struct({
  requestId: Schema.optionalKey(Schema.NonEmptyString),
  kind: Kind.annotate({
    description:
      "name (a name for a thing), copy (a headline, tagline or short text), concept (an idea, mechanic or angle), or visual-direction (a look: method, palette, layout, type).",
  }),
  brief: Schema.NonEmptyString.annotate({
    description: "What to make options for, in plain words: the thing, where it lives, its job.",
  }),
  context: Schema.optionalKey(
    Schema.NonEmptyString.annotate({
      description:
        "The project the options belong to: its world, audience, constraints, odd details, what exists already. Thin or missing context makes the agent start from a random seed instead.",
    }),
  ),
  count: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_COUNT })).annotate({
      description: `How many options, 1 to ${MAX_COUNT}. Default ${DEFAULT_COUNT}.`,
    }),
  ),
});

/** One option: the choice, the obvious pick it moved away from, and the fact about the project that justifies it. */
export const CreativeOption = Schema.Struct({
  option: Schema.NonEmptyString.annotate({
    description: "The name, the text, the idea or the visual direction itself.",
  }),
  avoided: Schema.NonEmptyString.annotate({
    description: "The obvious or average pick this option moved away from, in one line.",
  }),
  why: Schema.NonEmptyString.annotate({
    description: "One sentence on why it fits this project, naming a fact about the project.",
  }),
});
export type CreativeOption = typeof CreativeOption.Type;

/** `creative.options`: N distinct options and the one the agent recommends. */
export const CreativeOptions = Schema.Struct({
  requestId: Schema.optionalKey(Schema.NonEmptyString),
  kind: Kind,
  brief: Schema.String,
  options: Schema.Array(CreativeOption).annotate({
    description: "Exactly `count` options, different in kind and not variations of one idea.",
  }),
  pick: Schema.Int.annotate({ description: "The recommended option, 1-based." }),
  pickWhy: Schema.String.annotate({ description: "Why that one, in one or two sentences." }),
  text: Schema.String.annotate({ description: "The options as readable Markdown." }),
  model: Schema.String,
  attempts: Schema.Int,
  cost: Schema.Number,
  seconds: Schema.Number,
});

/** Registered with the domain's pack under these names; `AGENT.md` refers to them as `request` and `reply`. */
export const schemas = {
  "creative.requested": CreativeRequested,
  "creative.options": CreativeOptions,
};
