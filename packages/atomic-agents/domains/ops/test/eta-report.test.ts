import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Ref, Schema } from "effect";
import { EtaReportError, EtaSources, spec } from "../agents/eta-report/agent.ts";
import {
  baselineOf,
  compare,
  median,
  message,
  section,
  summarize,
  verdict,
  withSection,
  type EstimateRun,
  type Report,
  type Week,
} from "../agents/eta-report/compute.ts";
import { Agents } from "../../../src/core/Agent.ts";
import { define } from "../../../src/core/Component.ts";
import { EventBus } from "../../../src/core/Event.ts";
import { Runner } from "../../../src/core/Runtime.ts";
import { runtime, tempHome } from "../../../test/harness.ts";

const run = (kind: string, ratio: number): EstimateRun => ({ kind, ratio });

describe("eta-report computation", () => {
  test("median of odd and even lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  test("summarize: median ratio, share within 50%, worst kind by distance from 1", () => {
    const week = summarize([
      run("deploy/fix", 0.9),
      run("deploy/fix", 1.1),
      run("build/feature", 0.4),
      run("build/feature", 0.5),
      run("other", 1.6),
    ]);
    expect(week.n).toBe(5);
    expect(week.medianRatio).toBe(0.9);
    // 0.9, 1.1 and 0.5 are within 50%; 0.4 and 1.6 are not.
    expect(week.within50).toBeCloseTo(3 / 5);
    // build/feature median 0.45 is 2.2x off; other 1.6 is 1.6x off.
    expect(week.worstKind).toEqual({ kind: "build/feature", n: 2, medianRatio: 0.45 });
  });

  test("a run that took twice its estimate is as far from 1 as one that took half", () => {
    const week = summarize([run("a", 2), run("b", 0.5), run("c", 1.2)]);
    expect(week.worstKind?.kind).toBe("a");
  });

  test("no runs: n 0, nothing else", () => {
    expect(summarize([])).toEqual({ n: 0 });
  });

  test("compare needs both weeks to have numbers", () => {
    const now = summarize([run("a", 0.6), run("a", 0.8)]);
    const before = summarize([run("a", 1), run("a", 2.5)]);
    const change = compare(now, before)!;
    expect(change.medianRatio).toBeCloseTo(0.7 - 1.75);
    expect(change.within50Points).toBeCloseTo((1 - 0.5) * 100);
    expect(compare(now, undefined)).toBeUndefined();
    expect(compare(now, { n: 0 })).toBeUndefined();
    expect(compare({ n: 0 }, before)).toBeUndefined();
  });

  test("baseline picks the owner row", () => {
    const rows = [
      { group: "owner", bucket: "nova", n: 486, medianMin: 20.4 },
      { group: "owner", bucket: "astra", n: 12, medianMin: 9 },
      { group: "kind", bucket: "nova", n: 1, medianMin: 1 },
    ];
    expect(baselineOf(rows, "nova")).toEqual({ n: 486, medianMinutes: 20.4 });
    expect(baselineOf(rows, "isaac")).toBeUndefined();
  });

  test("verdict words", () => {
    expect(verdict(0.5)).toBe("quotes ran long");
    expect(verdict(1)).toBe("quotes on target");
    expect(verdict(1.4)).toBe("quotes ran short");
  });

  const view = (runs: ReadonlyArray<EstimateRun>, before?: Week): Report => {
    const week = summarize(runs);
    return {
      week,
      change: compare(week, before),
      baseline: { n: 486, medianMinutes: 20.4 },
      date: "2026-11-18",
      since: "7d",
      owner: "nova",
    };
  };

  test("message: first report has no comparison, stays 2 lines, no em dash", () => {
    const text = message(
      view([run("deploy/fix", 0.3), run("deploy/fix", 0.7), run("build/feature", 1.3)]),
    );
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain(
      "3 finished runs with an estimate: median actual/estimate 0.70 (quotes ran long), 67% within ±50%.",
    );
    expect(text).toContain("Worst kind: deploy/fix, median 0.50 (n=2).");
    expect(text).toContain("No last week to compare with.");
    expect(text).not.toContain("—");
  });

  test("message: change against last week", () => {
    const before = summarize([run("a", 0.4), run("a", 0.4)]);
    const text = message(view([run("a", 0.8), run("a", 1.0)], before));
    expect(text).toContain("Vs last week: median +0.50, within ±50% +100 pts.");
  });

  test("message: a week with no estimates says so and carries the baseline", () => {
    const text = message(view([]));
    expect(text).toBe(
      "No finished nova runs with an estimate in the last 7d (start them with --estimate <dur>).\nBaseline: 486 finished nova runs in 30 days, median 20.4m.",
    );
  });

  test("section lists the numbers; empty week says so", () => {
    const text = section(view([run("a", 0.5), run("b", 1.0)]));
    expect(text.startsWith("## Last week\n")).toBe(true);
    expect(text).toContain("- Finished runs with an estimate: 2");
    expect(text).toContain("- Median ratio: 0.75 (quotes ran long)");
    expect(text).toContain("- Worst job kind: a, median ratio 0.50 (n=1)");
    expect(section(view([]))).toContain("no finished nova runs with an estimate in the last 7d");
  });

  test("withSection replaces in place, inserts before the first section, or appends", () => {
    const body = "## Last week\n\nnew\n";
    const doc = "# Title\n\nintro\n\n## By def\n\ntable\n\n## Rules\n\nrule\n";
    const inserted = withSection(doc, body);
    expect(inserted).toBe(
      "# Title\n\nintro\n\n## Last week\n\nnew\n\n## By def\n\ntable\n\n## Rules\n\nrule\n",
    );
    const replaced = withSection(inserted, "## Last week\n\nnewer\n");
    expect(replaced).toBe(
      "# Title\n\nintro\n\n## Last week\n\nnewer\n\n## By def\n\ntable\n\n## Rules\n\nrule\n",
    );
    expect(withSection("# Title\n\nintro\n", body)).toBe(
      "# Title\n\nintro\n\n## Last week\n\nnew\n",
    );
    // The last section replaced keeps the file ending in one newline.
    expect(withSection("# T\n\n## Last week\n\nold\n", body)).toBe("# T\n\n## Last week\n\nnew\n");
  });
});

describe("eta-report agent", () => {
  const estimatesJson = (rows: ReadonlyArray<EstimateRun>) =>
    JSON.stringify({
      runs: rows.map((row, index) => ({
        id: `r${index}`,
        owner: "nova",
        agent: "helper",
        state: "done",
        title: "t",
        estimateMs: 600000,
        actualMs: row.ratio * 600000,
        ...row,
      })),
      summary: {},
    });
  const baselineJson = JSON.stringify([
    { group: "owner", bucket: "nova", n: 10, medianMin: 12, p75Min: 30 },
  ]);

  /** Fake tools: `estimates` answers by flag with the current week, `tell` records the line (or fails). */
  const fake = (
    notes: string,
    week: Ref.Ref<string>,
    told: Ref.Ref<ReadonlyArray<string>>,
    asked: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>,
    down = false,
  ) =>
    Layer.succeed(
      EtaSources,
      EtaSources.of({
        notesFile: () => notes,
        estimates: (args) =>
          Ref.update(asked, (all) => [...all, args]).pipe(
            Effect.andThen(
              args.includes("--baseline") ? Effect.succeed(baselineJson) : Ref.get(week),
            ),
          ),
        tell: (owner, text) =>
          down
            ? Effect.fail(new EtaReportError({ message: "thread down" }))
            : Ref.update(told, (all) => [...all, `${owner}: ${text}`]),
      }),
    );

  const evaRoot = (root: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = `${root}/eva`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(`${dir}/estimates.md`, "# ETA\n\nintro\n\n## By def\n\ntable\n");
      return `${root}/eva`;
    }).pipe(Effect.provide(BunServices.layer));

  const reports = Effect.gen(function* () {
    const decode = Schema.decodeUnknownSync(spec.events["ops.eta-report"]);
    return (yield* (yield* EventBus).history)
      .filter((event) => event.type === "eta-report/ops.eta-report")
      .map((event) => decode(event.data));
  });

  test("two weekly runs: tells nova, rewrites Last week, keeps the numbers, emits typed events", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* tempHome;
          const eva = yield* evaRoot(root);
          const told = yield* Ref.make<ReadonlyArray<string>>([]);
          const asked = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
          const week = yield* Ref.make(
            estimatesJson([run("deploy/fix", 0.5), run("deploy/fix", 0.5)]),
          );
          const fs = yield* FileSystem.FileSystem;

          const events = yield* Effect.gen(function* () {
            const runner = yield* Runner;
            expect((yield* runner.run("eta-report", "report", {})).ok).toBe(true);
            yield* Ref.set(
              week,
              estimatesJson([run("deploy/fix", 0.9), run("build/feature", 1.1)]),
            );
            expect((yield* runner.run("eta-report", "report", {})).ok).toBe(true);
            return yield* reports;
          }).pipe(
            Effect.provide(
              runtime(root, {
                code: [define({ ...spec, tools: fake(`${eva}/estimates.md`, week, told, asked) })],
              }),
            ),
          );

          expect(events).toHaveLength(2);
          expect(events[0]).toMatchObject({
            owner: "nova",
            since: "7d",
            n: 2,
            medianRatio: 0.5,
            within50: 1,
          });
          expect(events[0]!.change).toBeUndefined();
          expect(events[1]!.n).toBe(2);
          expect(events[1]!.medianRatio).toBeCloseTo(1);
          expect(events[1]!.change!.medianRatio).toBeCloseTo(0.5);
          expect(events[1]!.baseline).toEqual({ n: 10, medianMinutes: 12 });

          const messages = yield* Ref.get(told);
          expect(messages).toHaveLength(2);
          expect(messages[1]).toStartWith(
            "nova: [eta-report] 2 finished runs with an estimate: median actual/estimate 1.00",
          );
          expect(messages[1]).toContain("Vs last week: median +0.50");

          const calls = yield* Ref.get(asked);
          expect(calls[0]).toEqual(["--owner", "nova", "--since", "7d", "--json"]);
          expect(calls[1]).toEqual(["--owner", "nova", "--since", "30d", "--baseline", "--json"]);

          const notes = yield* fs.readFileString(`${eva}/estimates.md`);
          expect(notes.match(/^## Last week$/gm)).toHaveLength(1);
          expect(notes).toContain(
            "- Median ratio: 1.00 (quotes on target), +0.50 vs the week before",
          );
          expect(notes.indexOf("## Last week")).toBeLessThan(notes.indexOf("## By def"));
          expect(
            JSON.parse(yield* fs.readFileString(`${root}/state/eta-report/last-week.json`)).week.n,
          ).toBe(2);
        }).pipe(Effect.provide(BunServices.layer)),
      ),
    );
  });

  test("an empty week reports it; a failing send fails the run and saves no week", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const asked = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
          const told = yield* Ref.make<ReadonlyArray<string>>([]);
          const empty = yield* Ref.make(JSON.stringify({ runs: [], summary: { n: 0 } }));

          const root = yield* tempHome;
          const eva = yield* evaRoot(root);
          const events = yield* Effect.gen(function* () {
            expect((yield* (yield* Runner).run("eta-report", "report", {})).ok).toBe(true);
            return yield* reports;
          }).pipe(
            Effect.provide(
              runtime(root, {
                code: [define({ ...spec, tools: fake(`${eva}/estimates.md`, empty, told, asked) })],
              }),
            ),
          );
          expect(events).toMatchObject([{ n: 0, baseline: { n: 10, medianMinutes: 12 } }]);
          expect((yield* Ref.get(told))[0]).toStartWith(
            "nova: [eta-report] No finished nova runs with an estimate in the last 7d",
          );
          expect(yield* fs.readFileString(`${eva}/estimates.md`)).toContain(
            "no finished nova runs with an estimate",
          );

          const other = yield* tempHome;
          const eva2 = yield* evaRoot(other);
          const failed = yield* Effect.gen(function* () {
            const result = yield* (yield* Runner).run("eta-report", "report", {});
            return { ok: result.ok, events: yield* reports };
          }).pipe(
            Effect.provide(
              runtime(other, {
                code: [
                  define({
                    ...spec,
                    tools: fake(`${eva2}/estimates.md`, empty, told, asked, true),
                  }),
                ],
              }),
            ),
          );
          expect(failed).toEqual({ ok: false, events: [] });
          expect(yield* fs.exists(`${other}/state/eta-report/last-week.json`)).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
      ),
    );
  });

  test("is a weekly Wednesday 09:00 cron job and loads from its agent file as a code agent", async () => {
    const trigger = spec.jobs[0]!.triggers.find((candidate) => candidate._tag === "Cron");
    expect(trigger?._tag === "Cron" ? trigger.cron : undefined).toBe("0 9 * * 3");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* tempHome;
          const loaded = yield* Effect.gen(function* () {
            return (yield* (yield* Agents).current).find((agent) => agent.id === "eta-report");
          }).pipe(
            Effect.provide(
              runtime(root, { dirs: [new URL("../agents", import.meta.url).pathname] }),
            ),
          );
          expect(loaded?.kind).toBe("code");
          expect(loaded?.jobs.map((candidate) => candidate.id)).toEqual(["report"]);
        }).pipe(Effect.provide(BunServices.layer)),
      ),
    );
  });
});
