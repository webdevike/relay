import { Schema } from "effect";
import { AppState } from "./adapters/soundly.ts";

/** Most sounds one collection gets; Soundly's own cap is 5000, previewing is the point. */
export const MAX_COUNT = 25;
export const DEFAULT_COUNT = 8;

/** `sound.requested`: what to find. */
export const SoundRequested = Schema.Struct({
  requestId: Schema.optionalKey(Schema.NonEmptyString),
  query: Schema.NonEmptyString.annotate({
    description:
      "The sound wanted, in plain words (what it is, its character, length): searched in Soundly as written.",
  }),
  count: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_COUNT })).annotate({
      description: `How many sounds to collect (default ${DEFAULT_COUNT}, at most ${MAX_COUNT}).`,
    }),
  ),
});
export type SoundRequested = typeof SoundRequested.Type;

/** One collected sound, as Soundly lists it. */
export const Sound = Schema.Struct({
  title: Schema.String,
  library: Schema.String,
  /** Seconds. */
  duration: Schema.Number,
  /** Soundly's file id (`SND…`). */
  id: Schema.String,
});
export type Sound = typeof Sound.Type;

/** `sound.collected`: the temporary collection in Soundly, ready to preview. */
export const SoundCollected = Schema.Struct({
  requestId: Schema.optionalKey(Schema.NonEmptyString),
  query: Schema.String,
  collection: Schema.String.annotate({
    description: "The collection's name in Soundly, under My Collections.",
  }),
  sounds: Schema.Array(Sound),
  /** Searched with Soundly's semantic search, or its keyword search when that failed. */
  search: Schema.Literals(["semantic", "keyword"]),
  /** Isaac's Soundly app around the run: quit and relaunched hidden when it was open, and seen signed in again. */
  soundly: AppState,
  model: Schema.String,
  attempts: Schema.Int,
  cost: Schema.Number,
  seconds: Schema.Number,
});
export type SoundCollected = typeof SoundCollected.Type;
