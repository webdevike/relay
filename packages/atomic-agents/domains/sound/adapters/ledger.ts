import { Effect, FileSystem, Path, Schema } from "effect";
import { PREFIX, SoundlyError, type SoundlyApi } from "./soundly.ts";

/**
 * The sound domain's state, in `<home>/state/sound/`:
 * - `collections.json`: the collections Eva made, so cleanup knows their age. A collection is deleted only when its
 *   live name still starts with `Eva picks: ` AND the account owns it (`Admin`); Isaac's own collections never match.
 * - `searches.json`: the last searches with the candidates Soundly returned, the cases the bench replays offline.
 */

/** How long an Eva picks collection lives before cleanup removes it. */
export const TTL_HOURS = 24;
/** Searches kept for the bench. */
const MAX_SEARCHES = 40;

export const Entry = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  query: Schema.String,
  /** ISO 8601. */
  createdAt: Schema.String,
});
export type Entry = typeof Entry.Type;

export const Search = Schema.Struct({
  query: Schema.String,
  count: Schema.Int,
  mode: Schema.Literals(["semantic", "keyword"]),
  /** ISO 8601. */
  at: Schema.String,
  candidates: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.String,
      seconds: Schema.Number,
      libraryId: Schema.String,
    }),
  ),
});
export type Search = typeof Search.Type;

/** The domain's shared state dir, beside the calling agent's own (`<home>/state/<agent>`). */
export const soundStateDir = (path: Path.Path, stateDir: string) =>
  path.join(path.dirname(stateDir), "sound");

const readList = <A>(dir: string, name: string, schema: Schema.Codec<A>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(dir, name);
    if (!(yield* fs.exists(file))) return [] as ReadonlyArray<A>;
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(schema)))(
      yield* fs.readFileString(file),
    );
  }).pipe(Effect.mapError((error) => new SoundlyError({ message: `${name}: ${error.message}` })));

const writeList = <A>(dir: string, name: string, items: ReadonlyArray<A>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(dir, name);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${file}.tmp`, `${JSON.stringify(items, null, 2)}\n`);
    yield* fs.rename(`${file}.tmp`, file);
  }).pipe(Effect.mapError((error) => new SoundlyError({ message: `${name}: ${error.message}` })));

export const readLedger = (dir: string) => readList(dir, "collections.json", Entry);
export const writeLedger = (dir: string, entries: ReadonlyArray<Entry>) =>
  writeList(dir, "collections.json", entries);
export const readSearches = (dir: string) => readList(dir, "searches.json", Search);

/** Keeps a search (newest last, at most MAX_SEARCHES) for the bench. */
export const recordSearch = (dir: string, search: Search) =>
  Effect.flatMap(readSearches(dir), (searches) =>
    writeList(dir, "searches.json", [...searches, search].slice(-MAX_SEARCHES)),
  );

/** Which ledger entries are due: every one with `all`, else those older than `olderThanHours`. */
export const due = (
  entries: ReadonlyArray<Entry>,
  now: number,
  options: { readonly all?: boolean; readonly olderThanHours?: number },
) =>
  entries.filter(
    (entry) =>
      options.all === true ||
      now - Date.parse(entry.createdAt) >= (options.olderThanHours ?? TTL_HOURS) * 3_600_000,
  );

/**
 * Deletes, in one signed-in session: the due ledger collections that still exist and are still Eva's, plus every Eva
 * picks collection the ledger does not know (made before it, or by a run that lost its ledger), whose age is unknown.
 * Drops the due entries from the ledger (one Isaac deleted or renamed away is simply forgotten). Returns the names
 * deleted.
 */
export const sweep = (
  api: SoundlyApi,
  dir: string,
  options: { readonly now: number; readonly all?: boolean; readonly olderThanHours?: number },
) =>
  Effect.gen(function* () {
    const entries = yield* readLedger(dir);
    const expired = new Set(due(entries, options.now, options).map((entry) => entry.key));
    const known = new Set(entries.map((entry) => entry.key));
    const doomed = (yield* api.collections).filter(
      (collection) =>
        collection.name.startsWith(PREFIX) &&
        collection.permissions === "Admin" &&
        (expired.has(collection.key) || !known.has(collection.key)),
    );
    for (const collection of doomed) yield* api.remove(collection.key);
    if (expired.size > 0)
      yield* writeLedger(
        dir,
        entries.filter((entry) => !expired.has(entry.key)),
      );
    return doomed.map((collection) => collection.name);
  });
