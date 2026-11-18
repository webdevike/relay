import { Effect, Schema } from "effect";
import { eventType, ToolMode } from "./Component.ts";
import { type EventBus, JournalError, makeEvent } from "./Event.ts";
import { shortId } from "./Id.ts";

/**
 * The runtime's own contract (`atomic-agents/<name>`): config.json and agent file changes. Declared here,
 * apart from `Settings.ts` and `Agent.ts`, since both publish them.
 */
export const RUNTIME = "atomic-agents";

export const Thinking = Schema.Literals(["off", "minimal", "low", "medium", "high"]);
/** How a consumer uses a component's answers: log them only (`shadow`), use them (`live`), or ask nothing (`off`). */
export const Mode = Schema.Literals(["shadow", "live", "off"]);
export type Mode = typeof Mode.Type;

const AtLeastOne = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * Bounds on trial mode (`Trial.ts` `trialAllowance`), at the top of config.json for every agent and per component
 * (each key wins over the top's, which wins over the defaults). Over either bound a caller's request runs once, on the
 * agent's own model, with no arms.
 */
export const TrialLimits = Schema.Struct({
  /** Trials an agent starts in any 24 hours; default 3 (`TRIAL_PER_DAY`). 0 never starts one. */
  perDay: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /**
   * Trials offered this many days since the agent's epoch (its last switch, undo or re-trial) with no pick in the last
   * this many days stop until a pick, switch or re-trial; default 7 (`TRIAL_IDLE_DAYS`).
   */
  idleDays: Schema.optionalKey(AtLeastOne),
});
export type TrialLimits = typeof TrialLimits.Type;

/**
 * Relay Host's automatic widget pass after an assistant's reply (`apps/linux/src/widgets/gate.ts`), only under
 * `components.widget`. The runtime ignores it; the host reads it on every reply, like `mode`. Each key is the least
 * count that makes a reply worth asking the widget agent about, or the wait; absent keys take the host's defaults.
 */
export const AutoAsk = Schema.Struct({
  /** Measures to compare: currency, %, a number with a unit, either side of "N vs N" (default 3). */
  numbers: Schema.optionalKey(AtLeastOne),
  /** Table rows, list items and "Label: ..." lines holding a number (default 3). */
  items: Schema.optionalKey(AtLeastOne),
  /** Distinct ticket or PR keys, `ENG-123` or `#123` (default 2). */
  keys: Schema.optionalKey(AtLeastOne),
  /** Images; one is enough with before/after wording (default 2). */
  media: Schema.optionalKey(AtLeastOne),
  /** How long the host waits for the agent's answer, in ms (default 35000, past the agent's own 30 s timeout). */
  waitMs: Schema.optionalKey(AtLeastOne),
});

export const ComponentSettings = Schema.Struct({
  /** Default true. A disabled component's triggers do not fire and manual runs are refused. */
  enabled: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.NonEmptyString),
  /** Backup model: when a run on `model` fails (provider error, rate limit, timeout, attempts exhausted) the runtime retries the job once on it. `atomic-agents use <id> <model> --fallback <model>` writes it. */
  fallbackModel: Schema.optionalKey(Schema.NonEmptyString),
  candidates: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  thinking: Schema.optionalKey(Thinking),
  /**
   * How the model uses its tools: `tools` (one call per turn) or `code` (one sandboxed script per turn over the tools
   * as a typed API). Only for an agent with tools; absent means the agent file's `job.toolMode`, else `tools`. Applied
   * from the next run, like `model`; `atomic-agents use <id> --tool-mode code` writes it. When to pick which: `docs/code-mode.md`.
   */
  toolMode: Schema.optionalKey(ToolMode),
  /** Job id → cron expression replacing that job's code cron. */
  cron: Schema.optionalKey(Schema.Record(Schema.String, Schema.NonEmptyString)),
  /**
   * For a component a consumer asks (widget: Relay Host under assistants' replies). The runtime ignores it;
   * the consumer reads it on every request, so a switch needs no restart. Absent means shadow.
   */
  mode: Schema.optionalKey(Mode),
  /**
   * Trial mode (`Trial.ts`): each caller's request also runs on the trial models and Relay shows the results blind as
   * A / B / C. Absent means the agent file's `trial`. The service turns it off when one model clearly wins and on
   * again when a new model appears in the provider catalog.
   */
  trial: Schema.optionalKey(Schema.Boolean),
  /** The trial's models (2 or 3; the agent's `model` is always one of them). Absent means `model` plus `candidates`. */
  trialModels: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** This agent's trial bounds over the top-level `trialLimits`. */
  trialLimits: Schema.optionalKey(TrialLimits),
  autoAsk: Schema.optionalKey(AutoAsk),
});

export const SettingsFile = Schema.Struct({
  /** Path of the OpenRouter key (absolute, or relative to the home dir). The key itself never goes in config. */
  openRouterKeyFile: Schema.optionalKey(Schema.NonEmptyString),
  components: Schema.optionalKey(Schema.Record(Schema.String, ComponentSettings)),
  /** Trial bounds for every agent; a component's own `trialLimits` keys win. */
  trialLimits: Schema.optionalKey(TrialLimits),
});
export type SettingsFile = typeof SettingsFile.Type;

/** Who changed config: `use`/`set` (a person or caller), `file` (an edit on disk), `trial` (the service, on Isaac's picks or a new model). */
export const Source = Schema.Literals(["use", "set", "file", "trial"]);
const Change = Schema.Struct({
  path: Schema.Array(Schema.String),
  /** `null` when the key was absent. */
  old: Schema.Json,
  new: Schema.Json,
});
export type Change = typeof Change.Type;
const Patch = Schema.Record(Schema.String, Schema.Json);
const ConfigKind = Schema.Literals(["spec", "code"]);

export const events = {
  /** Request: apply `patch` (JSON merge patch, RFC 7396: `null` removes a key) to config.json. The service applies it. */
  "config.set": Schema.Struct({ by: Schema.NonEmptyString, patch: Patch }),
  /** `undo` is the merge patch that restores the old values: emit it back as `config.set` to revert. */
  "config.changed": Schema.Struct({
    by: Schema.String,
    source: Source,
    changes: Schema.Array(Change),
    undo: Patch,
    config: SettingsFile,
  }),
  /** A bad config.json edit or request, or a bad agent file (`error` starts with its path); the last good version stays in force. */
  "config.rejected": Schema.Struct({ by: Schema.String, source: Source, error: Schema.String }),
  /** An agent file was loaded (new, or `replaced` an earlier version of the same id); its triggers are armed. */
  "agent.loaded": Schema.Struct({
    id: Schema.String,
    file: Schema.String,
    kind: ConfigKind,
    replaced: Schema.Boolean,
  }),
  /** An agent file was deleted: the agent is gone, its triggers with it. */
  "agent.removed": Schema.Struct({ id: Schema.String, file: Schema.String }),
  /** An orchestrator file was loaded (new or `replaced`); its cadence is armed unless it is disabled. */
  "orchestrator.loaded": Schema.Struct({
    id: Schema.String,
    file: Schema.String,
    enabled: Schema.Boolean,
    replaced: Schema.Boolean,
  }),
  /** An orchestrator file was deleted. */
  "orchestrator.removed": Schema.Struct({ id: Schema.String, file: Schema.String }),
  /**
   * Request: run `agent`'s `job` on `input` (`Requests.ts`, for an agent without an ask pair). The service runs it;
   * its `job.started` carries this `requestId`, so a caller finds the run and its events.
   */
  "run.requested": Schema.Struct({
    requestId: Schema.NonEmptyString,
    agent: Schema.NonEmptyString,
    job: Schema.NonEmptyString,
    input: Schema.Json,
  }),
  /** The service could not start a `run.requested` (no such agent or job, disabled, ...). */
  "run.rejected": Schema.Struct({
    requestId: Schema.String,
    agent: Schema.String,
    error: Schema.String,
  }),
};

export const runtime = { id: RUNTIME, events } as const;

/** Append a runtime event, encoded by its schema; `caller` (`AgentEvent.caller`) marks a request someone outside sent. */
export const publishRuntime = <K extends keyof typeof events>(
  bus: EventBus["Service"],
  name: K,
  data: (typeof events)[K]["Type"],
  job: string,
  caller?: string,
) =>
  Schema.encodeUnknownEffect(events[name])(data).pipe(
    Effect.mapError((cause) => new JournalError({ message: `encode ${RUNTIME}/${name}`, cause })),
    Effect.flatMap((encoded) =>
      Effect.flatMap(shortId, (id) =>
        makeEvent({
          type: eventType(runtime, name),
          component: RUNTIME,
          job,
          run: `${job}-${id}`,
          ...(caller === undefined ? {} : { caller }),
          data: encoded,
        }),
      ),
    ),
    Effect.flatMap(bus.publish),
  );
