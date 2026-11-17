import { Schema } from "effect";
import { type AgentSpec, Lines, Thinking, TriggerSpec } from "./AgentSpec.ts";
import { ToolMode } from "./Component.ts";

/**
 * An agent as a folder: `<id>/AGENT.md`, its `knowledge/` and its `bench/`. The YAML frontmatter names the parts
 * (model, request and reply, job, adapters); the Markdown body is the agent's instructions, its system prompt.
 * Request, reply (and a tool loop's answer) are schemas typed in code that a pack registers by name
 * (`Registry.schemas`, e.g. a domain's `schema.ts`); per-call data reaches the model through `prompt`'s `{{field}}`
 * placeholders. Every file in `knowledge/` loads up front, in `knowledge` order (default: name order), and nothing
 * outside the folder does. It compiles to the same agent spec as `<id>.json` (`AgentSpec.ts`): one job, the
 * request in, the reply out, asked as a pair.
 *
 *     ---
 *     id: diagram
 *     purpose: Turn a description of a flow ... into one polished diagram image.
 *     model: anthropic/claude-sonnet-5-5
 *     candidates: [anthropic/claude-sonnet-5-5, openai-codex/gpt-6-sol]
 *     request: diagram.requested
 *     reply: diagram.rendered
 *     show: image
 *     job: draw
 *     description: Draw the description as one SVG ...
 *     prompt: "{{brief}}"
 *     check: diagram.render
 *     ---
 *     You draw diagrams ...
 */
export const AGENT_DOC = "AGENT.md";

export const AgentDocFront = Schema.Struct({
  id: Schema.String,
  /** One sentence. If it needs two, it is two agents. */
  purpose: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  candidates: Schema.Array(Schema.NonEmptyString),
  thinking: Schema.optionalKey(Thinking),
  /** Harness the model runs in (a model adapter: `omp`, `codex`, `claude-code`), default `omp`. */
  harness: Schema.optionalKey(Schema.NonEmptyString),
  /** The registered schema of the request event (also the event's name). */
  request: Schema.NonEmptyString,
  /** The registered schema of the reply event (also the event's name). */
  reply: Schema.NonEmptyString,
  /** The reply field `atomic-agents ask` prints. */
  show: Schema.NonEmptyString,
  /** The job's id. */
  job: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  /** Default: the request event, and manual runs. */
  triggers: Schema.optionalKey(Schema.Array(TriggerSpec)),
  source: Schema.optionalKey(Schema.NonEmptyString),
  steps: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** The model's prompt per request; `{{field}}` inserts a request, source or step field. */
  prompt: Lines,
  attach: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** Seconds per model call (default 300). */
  timeout: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
  tools: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** The tool mode by default, with `tools`: `tools` or `code`. */
  mode: Schema.optionalKey(ToolMode),
  codeExample: Schema.optionalKey(Lines),
  /** The registered schema of the JSON a tool loop answers. */
  answer: Schema.optionalKey(Schema.NonEmptyString),
  answerExample: Schema.optionalKey(Schema.NonEmptyString),
  maxSteps: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  check: Schema.optionalKey(Schema.NonEmptyString),
  /** File names in `knowledge/`, in load order; default every file there, by name. */
  knowledge: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
});
export type AgentDocFront = typeof AgentDocFront.Type;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

/** `AGENT.md`'s frontmatter (YAML, not yet decoded) and body, or why the text has none. */
export const splitAgentDoc = (
  text: string,
):
  | { readonly ok: true; readonly front: string; readonly body: string }
  | { readonly ok: false; readonly error: string } => {
  const match = FRONTMATTER.exec(text);
  if (match === null)
    return { ok: false, error: "starts with no YAML frontmatter between --- lines" };
  const body = (match[2] ?? "").trim();
  if (body === "") return { ok: false, error: "has no instructions after the frontmatter" };
  return { ok: true, front: match[1]!, body };
};

/** A knowledge entry is a plain file name in the agent's `knowledge/`: nothing outside the folder loads. */
export const KNOWLEDGE_NAME = /^[A-Za-z0-9][\w.-]*$/;

/** The agent spec an `AGENT.md` stands for; `knowledge` are its files relative to the folder. */
export const toAgentSpec = (
  front: AgentDocFront,
  body: string,
  knowledge: ReadonlyArray<string>,
): AgentSpec => ({
  id: front.id,
  purpose: front.purpose,
  agent: {
    ...(front.harness === undefined ? {} : { harness: front.harness }),
    model: front.model,
    candidates: front.candidates,
    ...(front.thinking === undefined ? {} : { thinking: front.thinking }),
    system: body,
    knowledge: knowledge.map((file) => ({ file })),
  },
  events: { [front.request]: front.request, [front.reply]: front.reply },
  job: {
    id: front.job,
    description: front.description,
    input: front.request,
    triggers: front.triggers ?? [{ onEvent: front.request }, "manual"],
    ...(front.source === undefined ? {} : { source: front.source }),
    ...(front.steps === undefined ? {} : { steps: front.steps }),
    prompt: front.prompt,
    ...(front.attach === undefined ? {} : { attach: front.attach }),
    ...(front.timeout === undefined ? {} : { timeout: front.timeout }),
    ...(front.tools === undefined ? {} : { tools: front.tools }),
    ...(front.mode === undefined ? {} : { toolMode: front.mode }),
    ...(front.codeExample === undefined ? {} : { codeExample: front.codeExample }),
    ...(front.answer === undefined ? {} : { answer: front.answer }),
    ...(front.answerExample === undefined ? {} : { answerExample: front.answerExample }),
    ...(front.maxSteps === undefined ? {} : { maxSteps: front.maxSteps }),
    ...(front.check === undefined ? {} : { check: front.check }),
    output: front.reply,
  },
  asks: { request: front.request, reply: front.reply, show: front.show },
});
