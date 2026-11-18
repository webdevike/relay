import { Schema } from "effect";

export const Platform = Schema.Literals([
  "web",
  "github",
  "youtube",
  "reddit",
  "x",
  "xiaohongshu",
  "instagram",
  "facebook",
  "marketplace",
]);

export const Depth = Schema.Literals(["quick", "standard", "deep"]);

/** `research.asked`: one question to research. */
export const ResearchAsked = Schema.Struct({
  requestId: Schema.optionalKey(Schema.NonEmptyString),
  question: Schema.NonEmptyString,
  platforms: Schema.optionalKey(
    Schema.Array(Platform).annotate({
      description:
        "Platforms to search besides the web; instagram, facebook and marketplace go through Muse first.",
    }),
  ),
  depth: Schema.optionalKey(
    Depth.annotate({
      description:
        "Picks the model, effort and browsing budget. quick: Haiku, low effort, about 2 tool calls. standard (the default): Sonnet, medium effort, confirms key facts in a second source. deep: Opus, high effort, many reads of primary sources, every key claim verified, page screenshots for visual questions, a longer timeout.",
    }),
  ),
});

/** One cited source after the quote check. */
const Citation = Schema.Struct({
  url: Schema.String,
  quote: Schema.String,
  verified: Schema.Boolean,
  checked: Schema.Literals(["page", "excerpt", "muse", "none"]),
  via: Schema.String,
});

/** `research.answered`: the answer with every citation checked. */
export const ResearchAnswered = Schema.Struct({
  requestId: Schema.optionalKey(Schema.NonEmptyString),
  question: Schema.String,
  platforms: Schema.optionalKey(Schema.Array(Schema.String)),
  depth: Schema.optionalKey(Schema.String),
  answer: Schema.String,
  citations: Schema.Array(Citation),
  route: Schema.String,
  toolCalls: Schema.Json,
  model: Schema.String,
  attempts: Schema.Int,
  cost: Schema.Number,
  seconds: Schema.Number,
});

/** Registered with the domain's pack under these names; `AGENT.md` refers to them as `request`, `reply` and `answer`. */
export const schemas = {
  "research.asked": ResearchAsked,
  "research.answered": ResearchAnswered,
  "research.reply": Schema.Struct({
    answer: Schema.NonEmptyString,
    citations: Schema.Array(
      Schema.Struct({ url: Schema.NonEmptyString, quote: Schema.NonEmptyString }),
    ),
  }),
};
