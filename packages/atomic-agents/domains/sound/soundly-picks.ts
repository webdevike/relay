import { Clock, Effect, Path, Schema } from "effect";
import { type Component, define, job, Trigger } from "../../src/core/Component.ts";
import { ModelRunner } from "../../src/core/Model.ts";
import { previewOf } from "../../src/core/Trial.ts";
import { readLedger, recordSearch, soundStateDir, sweep, writeLedger } from "./adapters/ledger.ts";
import { type Match, PREFIX, Soundly, SoundlyError } from "./adapters/soundly.ts";
import { DEFAULT_COUNT, SoundCollected, SoundRequested } from "./schema.ts";

/**
 * `kind: "code"` agent (`soundly-picks.json`): one Soundly session per request (`Soundly.session`: waits while Isaac
 * uses Soundly, quits it if open, signs in once, relaunches it hidden and sees it signed in again, even when the work
 * fails). Inside the session: sweep expired Eva picks -> semantic search -> the model picks `count` -> new
 * "Eva picks: <query>" collection with them -> read back.
 */

export const SYSTEM = [
  "You pick sound effects for Isaac, a sound designer, from Soundly search results. He previews your picks in Soundly and chooses one, so give him the strongest, most varied options.",
  "",
  "You get his description and numbered candidates: Soundly file id, file name, Soundly's description, length in seconds.",
  "",
  "- Pick the candidates that best match the description's subject, action, material and character. Names and descriptions are often UCS style (CATEGORY_Subject, Action, Detail).",
  "- Respect what he states about length, distance, intensity, mood or setting. A matching subject with the wrong character ranks below a slightly looser subject with the right one.",
  "- Vary the set: at most two takes of the same recording (names that differ only by a number, a take letter or a mic name), unless he asks for takes.",
  "- Best first. Never invent ids: use only the ids in the list.",
  "- Pick exactly the number asked when that many fit; pick fewer only when fewer candidates truly match.",
  "",
  'Reply with one JSON object and nothing else: {"picks": ["SND123", "SND456"], "why": "<one short line on what you favoured>"}',
].join("\n");

/** The candidates the model chooses from: more than it keeps, so it can drop near-misses and duplicates. */
export const candidateCount = (count: number) => Math.min(60, Math.max(30, count * 4));

/** What the model sees of a search hit (recorded searches predate Pro and libraries are not shown). */
export type Candidate = Pick<Match, "id" | "name" | "description" | "seconds">;

export const promptFor = (query: string, count: number, candidates: ReadonlyArray<Candidate>) =>
  [
    `Description: ${query}`,
    `Pick: ${count}`,
    "",
    "Candidates (id | file name | description | seconds):",
    ...candidates.map(
      (match, index) =>
        `${index + 1}. ${match.id} | ${match.name} | ${match.description.replace(/\s+/g, " ").slice(0, 160)} | ${match.seconds}`,
    ),
  ].join("\n");

const Answer = Schema.Struct({
  picks: Schema.Array(Schema.String),
  why: Schema.optionalKey(Schema.String),
});
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer));

/**
 * The model's picks, or the problems with its reply: unreadable, ids not in the list, repeats, more than `count`, none.
 */
export const readPicks = (
  text: string,
  candidates: ReadonlyArray<Candidate>,
  count: number,
): { readonly picks: ReadonlyArray<string>; readonly problems: ReadonlyArray<string> } => {
  const body = /\{[\s\S]*\}/.exec(text)?.[0] ?? "";
  const answer = decodeAnswer(body);
  if (answer._tag === "None")
    return {
      picks: [],
      problems: ['the reply is not one JSON object {"picks": [...], "why": "..."}'],
    };
  const known = new Set(candidates.map((match) => match.id));
  const picks = answer.value.picks.map((id) => id.trim());
  const problems = [
    ...picks.filter((id) => !known.has(id)).map((id) => `${id} is not a candidate id`),
    ...(new Set(picks).size === picks.length ? [] : ["an id is picked twice"]),
    ...(picks.length > count ? [`${picks.length} picks, at most ${count}`] : []),
    ...(picks.length === 0 ? ["no picks"] : []),
  ];
  return { picks, problems };
};

/** `Eva picks: <query>`, cut to fit Soundly's sidebar; a time is added when the name is taken. */
export const collectionName = (query: string, taken: ReadonlySet<string>, now: Date) => {
  const words = query.replace(/\s+/g, " ").trim();
  const base = `${PREFIX}${words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words}`;
  if (!taken.has(base)) return base;
  const time = now.toTimeString().slice(0, 5);
  return `${base} ${time}`;
};

const events = {
  "sound.requested": SoundRequested,
  "sound.collected": SoundCollected,
  /** Expired Eva picks collections this run's session deleted on the way (see `soundly-cleanup`). */
  "expired.removed": Schema.Struct({ names: Schema.Array(Schema.String) }),
};

const pick = job(events, {
  id: "pick",
  description:
    'Search Soundly for the description, let the model pick `count` sounds, and put them in a new "Eva picks: <query>" collection for Isaac to preview. Waits while Isaac is using Soundly; signs in with the app\'s saved login (which signs the app out), then relaunches Soundly hidden and checks it is signed in again.',
  input: SoundRequested,
  triggers: [Trigger.Manual(), Trigger.OnEvent({ type: "soundly-picks/sound.requested" })],
  run: Effect.fnUntraced(function* (input, ctx) {
    const started = yield* Clock.currentTimeMillis;
    const path = yield* Path.Path;
    const soundly = yield* Soundly;
    const models = yield* ModelRunner;
    const dir = soundStateDir(path, ctx.stateDir);
    const count = input.count ?? DEFAULT_COUNT;

    const { value, app } = yield* soundly.session(dir, (api) =>
      Effect.gen(function* () {
        // This session already signed the app out, so expired picks go now rather than in a separate sign-in.
        const swept = yield* sweep(api, dir, { now: yield* Clock.currentTimeMillis });
        const found = yield* api.search(
          input.query,
          candidateCount(count),
          input.includePro ?? false,
        );
        if (found.matches.length === 0)
          return yield* new SoundlyError({
            message:
              found.proLeftOut > 0
                ? `Soundly found only Pro sounds for "${input.query}" (${found.proLeftOut} left out); ask with includePro to see them`
                : `Soundly found nothing for "${input.query}"`,
          });
        const want = Math.min(count, found.matches.length);
        const prompt = promptFor(input.query, want, found.matches);
        // One model's picks from the same candidates, with one repair turn: the same task, its reply, and what was wrong with it.
        const choose = (model: string) =>
          Effect.gen(function* () {
            const ask = (text: string) =>
              models.generate({
                model,
                system: ctx.agent.system,
                prompt: text,
                timeout: "90 seconds",
                ...(ctx.agent.thinking === undefined ? {} : { thinking: ctx.agent.thinking }),
              });
            const first = yield* ask(prompt);
            let reply = readPicks(first.text, found.matches, want);
            let attempts = 1;
            let cost = first.cost;
            if (reply.problems.length > 0) {
              const second = yield* ask(
                `${prompt}\n\nYour reply was:\n${first.text}\n\nIt was rejected: ${reply.problems.join("; ")}. Reply again with the JSON object only.`,
              );
              reply = readPicks(second.text, found.matches, want);
              attempts = 2;
              cost += second.cost;
              if (reply.problems.length > 0)
                return yield* new SoundlyError({
                  message: `the model's picks were unusable twice: ${reply.problems.join("; ")}`,
                });
            }
            const byId = new Map(found.matches.map((match) => [match.id, match]));
            return { chosen: reply.picks.flatMap((id) => byId.get(id) ?? []), attempts, cost };
          });
        const library = new Map(api.libraries.map((entry) => [entry.id, entry.name]));
        const soundOf = (match: Match) => ({
          title: match.name.replace(/\.(wav|aiff?|flac|mp3|ogg|m4a|caf)$/i, ""),
          library: library.get(match.libraryId) ?? match.libraryId,
          duration: match.seconds,
          id: match.id,
          pro: match.pro,
        });
        // A trial (`trialArms: "inline"`): the other models pick from the same search, beside this run and never in its
        // way; each result goes on Isaac's card as a list (no collection: one Soundly session at a time).
        for (const arm of ctx.trial?.others ?? []) {
          const report = ctx.trial!.report;
          yield* Effect.forkDetach(
            Effect.gen(function* () {
              const began = yield* Clock.currentTimeMillis;
              const took = Effect.map(Clock.currentTimeMillis, (now) => (now - began) / 1000);
              const outcome = yield* Effect.result(choose(arm.model));
              yield* outcome._tag === "Success"
                ? report(arm.letter, {
                    ok: true,
                    preview: previewOf({ sounds: outcome.success.chosen.map(soundOf) }),
                    seconds: yield* took,
                    cost: outcome.success.cost,
                  })
                : report(arm.letter, {
                    ok: false,
                    error: outcome.failure.message,
                    seconds: yield* took,
                  });
            }),
          );
        }
        const { chosen, attempts, cost } = yield* choose(ctx.model);

        const name = collectionName(
          input.query,
          new Set((yield* api.collections).map((collection) => collection.name)),
          new Date(yield* Clock.currentTimeMillis),
        );
        const made = yield* api.create(name);
        // In the ledger before the sounds go in, so a failed add still gets cleaned up.
        yield* writeLedger(dir, [
          ...(yield* readLedger(dir)),
          {
            key: made.key,
            name,
            query: input.query,
            createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          },
        ]);
        yield* api.add(made.key, chosen);
        const inside = new Set(yield* api.fileIds(made.key));
        const missing = chosen.filter((match) => !inside.has(match.id));
        if (missing.length > 0)
          return yield* new SoundlyError({
            message: `${name} lacks ${missing.map((match) => match.id).join(", ")} after adding`,
          });
        return {
          name,
          found,
          swept,
          attempts,
          cost,
          sounds: chosen.map(soundOf),
        };
      }),
    );

    if (value.swept.length > 0) yield* ctx.emit("expired.removed", { names: value.swept });
    yield* ctx.emit("sound.collected", {
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      query: input.query,
      collection: value.name,
      sounds: value.sounds,
      search: value.found.mode,
      soundly: app,
      model: ctx.model,
      attempts: value.attempts,
      cost: value.cost,
      proLeftOut: value.found.proLeftOut,
      seconds: ((yield* Clock.currentTimeMillis) - started) / 1000,
    });
    // The bench replays these candidate lists offline (no sign-in).
    yield* recordSearch(dir, {
      query: input.query,
      count,
      mode: value.found.mode,
      at: new Date(started).toISOString(),
      candidates: value.found.matches,
    });
    // The collection is there, but Isaac's app is not signed in again: the run fails loudly.
    if (app.problem !== undefined) return yield* new SoundlyError({ message: app.problem });
  }),
});

export const spec = {
  id: "soundly-picks",
  events,
  purpose:
    "Search Soundly for sounds matching a description and put the best ones into a temporary Soundly collection for Isaac to preview and pick.",
  agent: {
    model: "anthropic/claude-haiku-5-5",
    candidates: [
      "anthropic/claude-haiku-5-5",
      "openai-codex/gpt-6-luna",
      "anthropic/claude-sonnet-5-5",
    ],
    system: SYSTEM,
    // A taste call (which sounds suit him): Isaac picks its model blind (core/Trial.ts).
    trial: true,
  },
  jobs: [pick],
  tools: Soundly.layer,
  asks: {
    request: "sound.requested",
    reply: "sound.collected",
    show: (reply: unknown) => {
      const decoded = Schema.decodeUnknownOption(SoundCollected)(reply);
      return decoded._tag === "Some" ? decoded.value.collection : "none";
    },
  },
  // One Soundly session at a time: the other trial models pick from this run's search (see the job).
  trialArms: "inline",
} satisfies Component<Soundly>;

export default define(spec);
