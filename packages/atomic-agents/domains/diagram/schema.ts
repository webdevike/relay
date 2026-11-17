import { Schema } from "effect";

/** The diagram kinds a caller may name; each maps to one layout grammar in the agent's knowledge (`agents/diagram/knowledge/types.md`). */
export const Kind = Schema.Literals([
  "flow",
  "loop",
  "sequence",
  "architecture",
  "state",
  "timeline",
]);
export type Kind = typeof Kind.Type;

export const Theme = Schema.Literals(["dark", "light"]);
export type Theme = typeof Theme.Type;

/** `diagram.requested`: what to draw. */
export const DiagramRequested = Schema.Struct({
  requestId: Schema.optionalKey(Schema.NonEmptyString),
  description: Schema.NonEmptyString.annotate({
    description: "The flow, loop, architecture or structure to draw, in plain words.",
  }),
  kind: Schema.optionalKey(
    Kind.annotate({ description: "The diagram type; omitted, the agent picks the one that fits." }),
  ),
  title: Schema.optionalKey(
    Schema.NonEmptyString.annotate({ description: "Used verbatim as the diagram title." }),
  ),
  theme: Schema.optionalKey(Theme.annotate({ description: "Default dark." })),
});

/** `diagram.rendered`: the drawn diagram, rendered and checked. */
export const DiagramRendered = Schema.Struct({
  requestId: Schema.optionalKey(Schema.NonEmptyString),
  description: Schema.String,
  kind: Schema.optionalKey(Kind),
  title: Schema.optionalKey(Schema.String),
  theme: Theme,
  image: Schema.String.annotate({ description: "The PNG (2x the SVG's viewBox)." }),
  svg: Schema.String.annotate({ description: "The standalone SVG file (fonts imported)." }),
  source: Schema.String.annotate({ description: "The SVG text." }),
  summary: Schema.String.annotate({
    description: "The type drawn and what was merged or left out.",
  }),
  warnings: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Legibility problems the one repair turn did not fix.",
    }),
  ),
  width: Schema.Int,
  height: Schema.Int,
  model: Schema.String,
  attempts: Schema.Int,
  cost: Schema.Number,
  seconds: Schema.Number,
});

/** Registered with the domain's pack under these names; `AGENT.md` refers to them as `request` and `reply`. */
export const schemas = {
  "diagram.requested": DiagramRequested,
  "diagram.rendered": DiagramRendered,
};
