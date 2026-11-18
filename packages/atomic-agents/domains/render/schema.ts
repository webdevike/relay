import { Schema } from "effect";

/** `render.requested`: the object to model, and optionally the image to match. */
export const RenderRequested = Schema.Struct({
  requestId: Schema.optionalKey(Schema.NonEmptyString),
  subject: Schema.NonEmptyString.annotate({
    description: "The object to model, in a line (with a reference: what the reference shows).",
  }),
  reference: Schema.optionalKey(
    Schema.NonEmptyString.annotate({
      description:
        'An image the model must match (shape, proportions, materials, colors, camera angle): an absolute file path, a Relay drop path "/drops/<id>/<token>", or an http(s) URL. PNG, JPEG, WebP or GIF.',
    }),
  ),
});

/** `render.completed`: the model's render on the stage and its bare GLB. */
export const RenderCompleted = Schema.Struct({
  requestId: Schema.optionalKey(Schema.NonEmptyString),
  subject: Schema.String,
  reference: Schema.optionalKey(Schema.String),
  image: Schema.String.annotate({ description: "The 768x768 PNG render." }),
  glb: Schema.String.annotate({
    description: "The bare model as GLB (no floor, lights or camera).",
  }),
  script: Schema.String.annotate({ description: "The Blender build() script that made it." }),
  model: Schema.String,
  attempts: Schema.Int,
  seconds: Schema.Number,
  cost: Schema.Number,
});

/** Registered with the domain's pack under these names; `AGENT.md` refers to them as `request` and `reply`. */
export const schemas = {
  "render.requested": RenderRequested,
  "render.completed": RenderCompleted,
};
