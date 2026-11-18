// Trial mode as the atomic-agents service journals it (`<home>/events.ndjson`; packages/protocol trials.ts,
// widgets/bus.ts has the same no-import rule): `<agent>/trial.started` opens a card with its arms running,
// one `trial.result` per arm flips it, the host's `trial.picked` records Isaac's pick (the first one counts),
// `trial.switched` is the agent's own model switch and the host's `trial.undone` takes one back. The fold is
// what clients draw (`trials.snapshot`) plus what the phone rows' badges need. Models and their labels stay
// out of every arm until the card is picked.

import {
  TRIAL_SWITCH_BADGE_MS,
  TrialLetter,
  TrialPick,
  agentLabel,
  type Trial,
  type TrialArm,
  type TrialSwitch,
  type TrialsSnapshot,
} from "@relay/protocol";

/** The newest cards and switch messages a snapshot carries (the protocol's limits). */
export const MAX_TRIALS = 300;
export const MAX_SWITCHES = 100;

/** A trial arm's run as a badge shows it (the default arm's own run carries its letter instead). */
export interface TrialArmRun {
  readonly letter: TrialLetter;
  readonly status: TrialArm["status"];
  readonly startedAt?: number;
  readonly seconds?: number;
  /** The arm's model id; badges show it only once the trial is picked. */
  readonly model?: string;
}

/** A trial seen from the default arm's run: its letter, and the other arms that ran beside it. */
export interface TrialRunBadge {
  readonly trialId: string;
  readonly agent: string;
  readonly letter: TrialLetter;
  readonly others: readonly TrialArmRun[];
  /** Isaac picked: the models may show. */
  readonly picked: boolean;
}

/** An agent's latest switch still standing: its runs started within TRIAL_SWITCH_BADGE_MS after `at` name `toLabel`. */
export interface TrialSwitchBadge {
  readonly toLabel: string;
  readonly at: number;
}

export interface TrialBadges {
  /** By the default arm's request id (the `agents_ask` run). */
  readonly byRequest: ReadonlyMap<string, TrialRunBadge>;
  /** By agent id. */
  readonly switched: ReadonlyMap<string, TrialSwitchBadge>;
}

/** A switch's journal record the host needs to take it back. */
export interface TrialUndo {
  readonly agent: string;
  /** The merge patch that restores the old model and the trial (`trial.switched` data.undo). */
  readonly patch: unknown;
  /** Undo was taken already. */
  readonly undone: boolean;
}

export interface TrialsFold {
  readonly snapshot: TrialsSnapshot;
  readonly badges: TrialBadges;
  /** By switch id. */
  readonly undo: ReadonlyMap<string, TrialUndo>;
}

export const EMPTY_TRIALS_FOLD: TrialsFold = {
  snapshot: { trials: [], switches: [] },
  badges: { byRequest: new Map(), switched: new Map() },
  undo: new Map(),
};

interface JournalEvent {
  readonly type: string;
  readonly component: string;
  readonly at: number;
  readonly caller: string | undefined;
  readonly data: Record<string, unknown>;
}

interface ArmState {
  readonly letter: TrialLetter;
  readonly model: string;
  readonly label: string;
  readonly isDefault: boolean;
  status: TrialArm["status"];
  preview: string | undefined;
  error: string | undefined;
  seconds: number | undefined;
  startedAt: number | undefined;
}

interface TrialState {
  readonly id: string;
  readonly agent: string;
  readonly thread: string | undefined;
  readonly at: number;
  readonly request: string | undefined;
  requestId: string | undefined;
  readonly arms: ArmState[];
  pick: TrialPick | undefined;
  pickedAt: number | undefined;
}

interface SwitchState {
  readonly view: Omit<TrialSwitch, "thread" | "undone">;
  readonly trialId: string | undefined;
  readonly patch: unknown;
  undone: boolean;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const parse = (line: string): JournalEvent | null => {
  try {
    const event = record(JSON.parse(line));
    const type = text(event?.["type"]);
    const at = Date.parse(text(event?.["at"]) ?? "");
    const data = record(event?.["data"]);
    if (event === null || type === undefined || Number.isNaN(at) || data === null) return null;
    return {
      type,
      at,
      component: text(event["component"]) || type.slice(0, Math.max(0, type.indexOf("/"))),
      caller: text(event["caller"]),
      data,
    };
  } catch {
    return null;
  }
};

/**
 * The chat a caller belongs to (a ReactionThread): `agent:<id>` is assistant `<id>`'s thread, an omp session
 * file (`<dir>/<timestamp>_<id>.jsonl`) its session's, as the desktop's `sessionId(file)` reads it.
 */
export function callerThread(caller: string | undefined): string | undefined {
  if (caller === undefined || caller === "") return undefined;
  if (caller.startsWith("agent:")) {
    const id = caller.slice("agent:".length);
    return id === "" ? undefined : `assistant:${id}`;
  }
  if (!caller.includes("/") && !caller.endsWith(".jsonl")) return undefined;
  const stem = caller.slice(caller.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
  const id = stem.slice(stem.lastIndexOf("_") + 1);
  return id === "" ? undefined : `session:${id}`;
}

const parseArms = (value: unknown): ArmState[] | null => {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return null;
  const arms: ArmState[] = [];
  for (const raw of value) {
    const arm = record(raw);
    const letter = TrialLetter.safeParse(arm?.["letter"]);
    if (arm === null || !letter.success || arms.some((a) => a.letter === letter.data)) return null;
    arms.push({
      letter: letter.data,
      model: (text(arm["model"]) ?? "").slice(0, 200),
      label: (text(arm["label"]) ?? text(arm["model"]) ?? "").slice(0, 200),
      isDefault: arm["default"] === true,
      status: "running",
      preview: undefined,
      error: undefined,
      seconds: undefined,
      startedAt: undefined,
    });
  }
  return arms;
};

/**
 * Every trial card and switch message in the journal's `lines` (newest MAX_TRIALS / MAX_SWITCHES, journal
 * order), with the badges the phone rows need and each switch's undo patch. Lines that are no trial's are
 * skipped before they are parsed; bad ones are skipped. `now` drops switch badges older than TRIAL_SWITCH_BADGE_MS.
 */
export function trialsOfJournal(lines: readonly string[], now: number): TrialsFold {
  const trials = new Map<string, TrialState>();
  const switches = new Map<string, SwitchState>();
  for (const line of lines) {
    if (!line.includes("/trial.") && !(line.includes("/job.started") && line.includes('"trial"')))
      continue;
    const event = parse(line);
    if (event === null || event.component === "") continue;
    const name = event.type.slice(event.type.indexOf("/") + 1);
    const { data } = event;
    switch (name) {
      case "trial.started": {
        const id = text(data["trialId"]);
        const arms = parseArms(data["arms"]);
        if (id === undefined || id === "" || arms === null || trials.has(id)) break;
        const request = text(data["request"]);
        trials.set(id, {
          id: id.slice(0, 200),
          agent: event.component,
          thread: callerThread(text(data["caller"]) ?? event.caller),
          at: event.at,
          request: request === undefined ? undefined : request.slice(0, 500),
          requestId: text(data["requestId"]),
          arms,
          pick: undefined,
          pickedAt: undefined,
        });
        break;
      }
      case "trial.result": {
        const letter = text(data["letter"]);
        const arm = trials.get(text(data["trialId"]) ?? "")?.arms.find((a) => a.letter === letter);
        if (arm === undefined || arm.status !== "running") break;
        const ok = data["ok"] === true;
        arm.status = ok ? "done" : "failed";
        arm.seconds = number(data["seconds"]);
        if (ok) arm.preview = text(data["preview"])?.slice(0, 20_000);
        else arm.error = text(data["error"])?.slice(0, 1000);
        break;
      }
      case "trial.picked": {
        const trial = trials.get(text(data["trialId"]) ?? "");
        const pick = TrialPick.safeParse(data["pick"]);
        // The first pick counts; a second one (another device, a retry) changes nothing.
        if (trial === undefined || !pick.success || trial.pick !== undefined) break;
        trial.pick = pick.data;
        trial.pickedAt = event.at;
        break;
      }
      case "trial.switched": {
        const id = text(data["switchId"]);
        if (id === undefined || id === "" || switches.has(id)) break;
        const from = text(data["from"]) ?? "";
        const to = text(data["to"]) ?? "";
        switches.set(id, {
          view: {
            id: id.slice(0, 200),
            agent: event.component,
            label: agentLabel(event.component),
            at: event.at,
            text: (text(data["text"]) ?? "").slice(0, 1000),
            from: from.slice(0, 200),
            to: to.slice(0, 200),
            fromLabel: (text(data["fromLabel"]) ?? from).slice(0, 200),
            toLabel: (text(data["toLabel"]) ?? to).slice(0, 200),
            kept: data["kept"] === true,
          },
          trialId: text(data["trialId"]),
          patch: data["undo"],
          undone: false,
        });
        break;
      }
      case "trial.undone": {
        const taken = switches.get(text(data["switchId"]) ?? "");
        if (taken !== undefined) taken.undone = true;
        break;
      }
      case "job.started": {
        const tag = record(data["trial"]);
        const trial = trials.get(text(tag?.["id"]) ?? "");
        const arm = trial?.arms.find((a) => a.letter === text(tag?.["letter"]));
        if (trial === undefined || arm === undefined) break;
        arm.startedAt ??= event.at;
        trial.requestId ??= text(data["requestId"]) ?? text(record(data["input"])?.["requestId"]);
        break;
      }
    }
  }

  const kept = [...trials.values()].slice(-MAX_TRIALS);
  const byRequest = new Map<string, TrialRunBadge>();
  for (const t of kept) {
    const own = t.arms.find((a) => a.isDefault);
    if (t.requestId === undefined || own === undefined) continue;
    byRequest.set(t.requestId, {
      trialId: t.id,
      agent: t.agent,
      letter: own.letter,
      picked: t.pick !== undefined,
      others: t.arms
        .filter((a) => a !== own)
        .map((a) => {
          const startedAt = a.startedAt ?? t.at;
          return {
            letter: a.letter,
            status: a.status,
            startedAt,
            model: a.model,
            ...(a.seconds === undefined ? {} : { seconds: a.seconds }),
          };
        }),
    });
  }

  // An agent's latest switch names its new model on its badges for a while, unless it was taken back.
  const switched = new Map<string, TrialSwitchBadge>();
  const undo = new Map<string, TrialUndo>();
  for (const s of switches.values()) {
    undo.set(s.view.id, { agent: s.view.agent, patch: s.patch, undone: s.undone });
    if (s.view.kept) continue;
    if (s.undone || now - s.view.at >= TRIAL_SWITCH_BADGE_MS) switched.delete(s.view.agent);
    else switched.set(s.view.agent, { toLabel: s.view.toLabel, at: s.view.at });
  }

  const snapshot: TrialsSnapshot = {
    trials: kept.map((t): Trial => {
      const picked = t.pick !== undefined;
      return {
        id: t.id,
        agent: t.agent,
        label: agentLabel(t.agent),
        ...(t.thread === undefined ? {} : { thread: t.thread }),
        at: t.at,
        ...(t.request === undefined ? {} : { request: t.request }),
        // The model and its name only once the card is picked.
        arms: t.arms.map((a): TrialArm => ({
          letter: a.letter,
          status: a.status,
          ...(a.preview === undefined ? {} : { preview: a.preview }),
          ...(a.error === undefined ? {} : { error: a.error }),
          ...(a.seconds === undefined ? {} : { seconds: a.seconds }),
          ...(picked ? { model: a.model, modelLabel: a.label } : {}),
        })),
        ...(t.pick === undefined ? {} : { pick: t.pick }),
        ...(t.pickedAt === undefined ? {} : { pickedAt: t.pickedAt }),
      };
    }),
    switches: [...switches.values()].slice(-MAX_SWITCHES).map((s): TrialSwitch => {
      const thread = s.trialId === undefined ? undefined : trials.get(s.trialId)?.thread;
      return { ...s.view, ...(thread === undefined ? {} : { thread }), undone: s.undone };
    }),
  };
  return { snapshot, badges: { byRequest, switched }, undo };
}

/** What changes when a card or switch moves (an arm's state or start, a pick, an undo); equal signatures draw the same. */
export function trialsSignature(fold: TrialsFold): string {
  const trials = fold.snapshot.trials.map(
    (t) =>
      `${t.id}:${t.arms.map((a) => `${a.letter}${a.status[0] ?? ""}`).join("")}:${t.pick ?? ""}`,
  );
  const starts = [...fold.badges.byRequest.values()].map((b) =>
    b.others.map((a) => a.startedAt ?? "").join("/"),
  );
  const switches = fold.snapshot.switches.map((s) => `${s.id}:${s.undone ? 1 : 0}`);
  return `${trials.join(",")}|${starts.join(",")}|${switches.join(",")}|${[...fold.badges.switched.keys()].join(",")}`;
}
