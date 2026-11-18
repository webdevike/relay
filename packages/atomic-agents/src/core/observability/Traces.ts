import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { SPAN } from "./Spans.ts";

/**
 * The trace store: `<home>/traces/<UTC hour>.jsonl`, one OTLP/JSON `ExportTraceServiceRequest` per line (what
 * `Tracing.ts` writes), plus its retention and the reader behind `atomic-agents traces`.
 */
export const TRACES_DIR = "traces";

const HOUR = 3_600_000;
const FILE = /^(\d{4}-\d{2}-\d{2}T\d{2})\.jsonl$/;

/** The file a batch written at `millis` goes to: one per UTC hour, so retention drops whole hours. */
export const fileOf = (millis: number) => `${new Date(millis).toISOString().slice(0, 13)}.jsonl`;

/** When a trace file's hour starts; undefined for any other file. */
const hourOf = (name: string) => {
  const match = FILE.exec(name);
  return match === null ? undefined : Date.parse(`${match[1]}:00:00Z`);
};

export interface Retention {
  readonly maxAgeHours: number;
  /** Every trace file together. */
  readonly maxBytes: number;
  /** One hour's file stops taking batches here, so a runaway loop cannot spend the whole budget in an hour. */
  readonly maxHourBytes: number;
}

export const RETENTION: Retention = {
  maxAgeHours: 7 * 24,
  maxBytes: 64 * 1024 * 1024,
  maxHourBytes: 16 * 1024 * 1024,
};

/**
 * The trace files retention deletes: every hour that ended more than `maxAgeHours` ago, then the oldest hours until the
 * rest fit in `maxBytes`. The current hour's file is never deleted (`maxHourBytes` caps it instead).
 */
export const expired = (
  files: ReadonlyArray<{ readonly name: string; readonly bytes: number }>,
  now: number,
  retention: Retention,
): ReadonlyArray<string> => {
  const current = fileOf(now);
  const dated = files
    .flatMap((file) => {
      const hour = hourOf(file.name);
      return hour === undefined ? [] : [{ ...file, hour }];
    })
    .sort((a, b) => a.hour - b.hour);
  const cutoff = now - retention.maxAgeHours * HOUR;
  let total = dated.reduce((sum, file) => sum + file.bytes, 0);
  const gone: Array<string> = [];
  for (const file of dated) {
    if (file.name === current) continue;
    if (file.hour + HOUR <= cutoff || total > retention.maxBytes) {
      gone.push(file.name);
      total -= file.bytes;
    }
  }
  return gone;
};

/** Delete what `expired` names in `dir`; answers the deleted names. A file another process removed first is skipped. */
export const prune = (dir: string, now: number, retention: Retention) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = (yield* fs.readDirectory(dir)).filter((name) => hourOf(name) !== undefined);
    const files = yield* Effect.forEach(names, (name) =>
      fs.stat(path.join(dir, name)).pipe(
        Effect.map((info) => [{ name, bytes: Number(info.size) }]),
        Effect.orElseSucceed(() => []),
      ),
    );
    const gone = expired(files.flat(), now, retention);
    yield* Effect.forEach(gone, (name) => fs.remove(path.join(dir, name), { force: true }), {
      discard: true,
    });
    return gone;
  });

// Reading: the OTLP/JSON subset the tree needs. Array and map attribute values are skipped.
const AnyValue = Schema.Struct({
  stringValue: Schema.optionalKey(Schema.String),
  intValue: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  doubleValue: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  boolValue: Schema.optionalKey(Schema.Boolean),
});
const KeyValues = Schema.Array(Schema.Struct({ key: Schema.String, value: AnyValue }));
const OtlpSpan = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optionalKey(Schema.String),
  name: Schema.String,
  startTimeUnixNano: Schema.String,
  endTimeUnixNano: Schema.String,
  attributes: KeyValues,
  events: Schema.Array(
    Schema.Struct({ name: Schema.String, timeUnixNano: Schema.String, attributes: KeyValues }),
  ),
  status: Schema.Struct({ code: Schema.Number, message: Schema.optionalKey(Schema.String) }),
});
const decodeBatch = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      resourceSpans: Schema.Array(
        Schema.Struct({
          scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(OtlpSpan) })),
        }),
      ),
    }),
  ),
);

export type Attribute = string | number | boolean;

export interface SpanNode {
  readonly name: string;
  readonly spanId: string;
  /** Epoch milliseconds. */
  readonly start: number;
  readonly ms: number;
  readonly attributes: Readonly<Record<string, Attribute>>;
  /** Set when the span ended failed: the error's tag and message. */
  readonly error?: { readonly tag: string; readonly message: string };
  /** Log lines written inside the span (Effect records every log as a span event). */
  readonly logs: ReadonlyArray<{ readonly level: string; readonly message: string }>;
  readonly children: ReadonlyArray<SpanNode>;
}

export interface Trace {
  readonly traceId: string;
  /** The `agent.run` span; while the run is still going (or its root was pruned), a stand-in over the spans that ended. */
  readonly root: SpanNode;
  readonly open: boolean;
  readonly spans: number;
  readonly errors: number;
}

const attributesOf = (values: typeof KeyValues.Type) =>
  Object.fromEntries(
    values.flatMap(({ key, value }): ReadonlyArray<readonly [string, Attribute]> => {
      if (value.stringValue !== undefined) return [[key, value.stringValue]];
      if (value.boolValue !== undefined) return [[key, value.boolValue]];
      const number = value.intValue ?? value.doubleValue;
      return number === undefined ? [] : [[key, Number(number)]];
    }),
  );

interface Flat extends Omit<SpanNode, "children"> {
  readonly traceId: string;
  readonly parentSpanId?: string;
}

/** Every span in OTLP/JSON lines; a torn or foreign line is skipped. */
export const parseLines = (text: string): ReadonlyArray<Flat> =>
  text.split("\n").flatMap((line) =>
    Option.match(decodeBatch(line), {
      onNone: () => [],
      onSome: (batch) =>
        batch.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) =>
            scope.spans.map((span): Flat => {
              const attributes = attributesOf(span.attributes);
              const start = Number(BigInt(span.startTimeUnixNano) / 1_000_000n);
              const exception = span.events.find((event) => event.name === "exception");
              const thrown = exception === undefined ? {} : attributesOf(exception.attributes);
              return {
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
                name: span.name,
                start,
                ms: Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1e6,
                attributes,
                ...(span.status.code === 2
                  ? {
                      error: {
                        tag: String(attributes["error.tag"] ?? thrown["exception.type"] ?? "Error"),
                        message: String(attributes["error.message"] ?? span.status.message ?? ""),
                      },
                    }
                  : {}),
                logs: span.events.flatMap((event) => {
                  if (event.name === "exception") return [];
                  const level = attributesOf(event.attributes)["effect.logLevel"];
                  return [{ level: String(level ?? "EVENT"), message: event.name }];
                }),
              };
            }),
          ),
        ),
    }),
  );

/** Spans grouped by trace, each a tree under its root, oldest child first. */
export const buildTraces = (spans: ReadonlyArray<Flat>): ReadonlyArray<Trace> => {
  const byTrace = new Map<string, Array<Flat>>();
  for (const span of spans) {
    const list = byTrace.get(span.traceId) ?? [];
    list.push(span);
    byTrace.set(span.traceId, list);
  }
  return [...byTrace].map(([traceId, flat]) => {
    const ids = new Set(flat.map((span) => span.spanId));
    const children = new Map<string | undefined, Array<Flat>>();
    for (const span of flat) {
      const parent =
        span.parentSpanId !== undefined && ids.has(span.parentSpanId)
          ? span.parentSpanId
          : undefined;
      const list = children.get(parent) ?? [];
      list.push(span);
      children.set(parent, list);
    }
    const tree = (span: Flat): SpanNode => {
      const { traceId: _trace, parentSpanId: _parent, ...node } = span;
      return {
        ...node,
        children: (children.get(span.spanId) ?? []).sort((a, b) => a.start - b.start).map(tree),
      };
    };
    const tops = (children.get(undefined) ?? []).sort((a, b) => a.start - b.start).map(tree);
    const closed = tops.length === 1 && tops[0]!.name === SPAN.run ? tops[0] : undefined;
    const start = Math.min(...flat.map((span) => span.start));
    const end = Math.max(...flat.map((span) => span.start + span.ms));
    // Every span of a run carries agent.id, agent.run and agent.tier, so a stand-in root still says whose it is.
    const shared = Object.fromEntries(
      ["agent.id", "agent.run", "agent.tier"].flatMap((key) => {
        const value = flat.find((span) => span.attributes[key] !== undefined)?.attributes[key];
        return value === undefined ? [] : [[key, value]];
      }),
    );
    const root: SpanNode = closed ?? {
      name: SPAN.run,
      spanId: "",
      start,
      ms: end - start,
      attributes: shared,
      logs: [],
      children: tops,
    };
    return {
      traceId,
      root,
      open: closed === undefined,
      spans: flat.length,
      errors: flat.filter((span) => span.error !== undefined).length,
    };
  });
};

export interface TraceQuery {
  readonly agent?: string;
  /** A job run id or request id, or the start of one. */
  readonly run?: string;
  /** Only runs with a failed span. */
  readonly errors?: boolean;
  /** Slowest first instead of newest first. */
  readonly slow?: boolean;
  /** Epoch milliseconds: runs that started since. */
  readonly since: number;
  readonly limit: number;
}

export const select = (traces: ReadonlyArray<Trace>, query: TraceQuery) =>
  traces
    .filter((trace) => {
      const { attributes } = trace.root;
      if (trace.root.start < query.since) return false;
      if (query.agent !== undefined && attributes["agent.id"] !== query.agent) return false;
      if (query.errors === true && trace.errors === 0) return false;
      const run = query.run;
      return (
        run === undefined ||
        [attributes["agent.run"], attributes["agent.request"]].some(
          (id) => typeof id === "string" && id.startsWith(run),
        )
      );
    })
    .sort((a, b) => (query.slow === true ? b.root.ms - a.root.ms : b.root.start - a.root.start))
    .slice(0, query.limit);

/** `30m`, `1h`, `2d` as milliseconds. */
export const parseSince = (value: string) => {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (match === null) return undefined;
  return Number(match[1]) * { m: 60_000, h: HOUR, d: 24 * HOUR }[match[2] as "m" | "h" | "d"];
};

/** Traces in `<root>/traces` that started since `query.since`, filtered and ordered by `query`. */
export const query = (root: string, query: TraceQuery) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(root, TRACES_DIR);
    if (!(yield* fs.exists(dir))) return [];
    const names = (yield* fs.readDirectory(dir)).filter((name) => {
      const hour = hourOf(name);
      return hour !== undefined && hour + HOUR > query.since;
    });
    const texts = yield* Effect.forEach(names, (name) =>
      fs.readFileString(path.join(dir, name)).pipe(Effect.orElseSucceed(() => "")),
    );
    return select(buildTraces(texts.flatMap(parseLines)), query);
  });

const duration = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);

/** What a span line shows after its name, in this order; keys a span lacks are skipped. */
const LABEL: ReadonlyArray<readonly [string, (value: Attribute) => string]> = [
  ["model.harness", String],
  ["model.id", String],
  ["fallback.from", (value) => `fallback from ${value}`],
  ["tool.name", String],
  ["tool.caller", (value) => (value === "script" ? "(script)" : "")],
  ["tool.args", String],
  ["source.name", String],
  ["source.items", (value) => `${value} items`],
  ["step.name", String],
  ["check.name", String],
  ["check.attempt", (value) => `attempt ${value}`],
  ["check.pass", (value) => (value === true ? "pass" : "fail")],
  ["event.type", String],
  ["tokens.input", (value) => `in ${value}`],
  ["tokens.output", (value) => `out ${value}`],
  ["tokens.cached", (value) => (value === 0 ? "" : `cached ${value}`)],
  ["cost.usd", (value) => `$${Number(value).toFixed(4)}`],
];

const ROOT_LABEL: ReadonlyArray<readonly [string, (value: Attribute) => string]> = [
  ["agent.run", (value) => `run ${value}`],
  ["agent.request", (value) => `request ${value}`],
  ["model.id", String],
  ["run.fell_back", (value) => (value === true ? "(fell back)" : "")],
  ["agent.tier", (value) => `tier ${value}`],
  ["agent.trial", (value) => `trial ${value}`],
  ["agent.queued_ms", (value) => (Number(value) < 1000 ? "" : `queued ${duration(Number(value))}`)],
];

const labelOf = (
  attributes: Readonly<Record<string, Attribute>>,
  keys: ReadonlyArray<readonly [string, (value: Attribute) => string]>,
) =>
  keys
    .flatMap(([key, show]) => (attributes[key] === undefined ? [] : [show(attributes[key])]))
    .filter((part) => part !== "")
    .join(" ");

const statusOf = (node: SpanNode) =>
  node.error === undefined
    ? ""
    : `  ✗ ${node.error.tag}${node.error.message === "" ? "" : `: ${node.error.message.replace(/\s+/g, " ").slice(0, 160)}`}`;

/** A trace as a compact tree: one line per span (name, what it is, how long, how it failed), its logs under it. */
export const render = (trace: Trace): string => {
  const { root } = trace;
  const who = [root.attributes["agent.id"], root.attributes["agent.job"]]
    .filter((part) => part !== undefined)
    .join("/");
  const status = trace.open ? " (open)" : root.error === undefined ? " ok" : "";
  const lines = [
    `${new Date(root.start).toISOString().replace("T", " ").slice(0, 19)}  ${SPAN.run} ${who} ${labelOf(root.attributes, ROOT_LABEL)}  ${duration(root.ms)}${status}${statusOf(root)}`,
  ];
  const walk = (nodes: ReadonlyArray<SpanNode>, prefix: string) =>
    nodes.forEach((node, index) => {
      const last = index === nodes.length - 1;
      const label = labelOf(node.attributes, LABEL);
      lines.push(
        `${prefix}${last ? "└─ " : "├─ "}${node.name}${label === "" ? "" : ` ${label}`}  ${duration(node.ms)}${statusOf(node)}`,
      );
      const inner = `${prefix}${last ? "   " : "│  "}`;
      for (const log of node.logs)
        lines.push(`${inner}· ${log.level} ${log.message.replace(/\s+/g, " ").slice(0, 160)}`);
      walk(node.children, inner);
    });
  for (const log of root.logs)
    lines.push(`· ${log.level} ${log.message.replace(/\s+/g, " ").slice(0, 160)}`);
  walk(root.children, "");
  return lines.join("\n");
};
