/**
 * Specialist agents in a chat, as the phone draws them (protocol `agent-runs.ts`): where a session's runs show,
 * what the badge says, and what a run's opened details hold.
 */
import { z } from "zod";
import { agentClock, agentRunsByRow, type AgentMessage, type AgentRun } from "@relay/protocol";

/** The badge's state: accent while any run works, danger when every run failed, else quiet. */
export type AgentsTone = "running" | "failed" | "done";

export function agentsTone(runs: readonly AgentRun[]): AgentsTone {
  if (runs.some((run) => run.status === "running")) return "running";
  return runs.every((run) => run.status === "failed") ? "failed" : "done";
}

/** A session transcript's runs by the id of the row they show under: each turn's last reply, else its last agents call. */
export function sessionAgentRuns(rows: readonly AgentMessage[]): Map<string, AgentRun[]> {
  const byIndex = agentRunsByRow(rows, (row) =>
    row.role === "user"
      ? "user"
      : row.role === "assistant" && row.text.trim().length > 0
        ? "reply"
        : row.agentRun,
  );
  const out = new Map<string, AgentRun[]>();
  for (const [index, runs] of byIndex) {
    const row = rows[index];
    if (row !== undefined) out.set(row.id, runs);
  }
  return out;
}

const Citation = z.object({
  url: z.string().min(1),
  quote: z.string().optional(),
  verified: z.boolean().optional(),
});
export type Citation = z.infer<typeof Citation>;
/** A typed reply as agents write them: any fields, an `answer` and `citations` when it has them. */
const Reply = z.record(z.unknown());
const Asked = z.object({ question: z.string() });

/** What a run's opened details show: what was asked, the answer, its citations, any other reply fields, and its cost line. */
export interface AgentRunDetail {
  asked: string | null;
  answer: string | null;
  citations: Citation[];
  /** Reply fields beyond the answer and citations, as `name: value` lines. */
  fields: string[];
  /** `29s · $0.004` once done. */
  meta: string | null;
}

/** A value as one readable line: text as is, anything else as compact JSON. */
function plain(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function agentRunDetail(run: AgentRun): AgentRunDetail {
  const asked = Asked.safeParse(run.request);
  const parsed = Reply.safeParse(run.reply);
  const reply = parsed.success ? parsed.data : {};
  const answer = run.text ?? (typeof reply["answer"] === "string" ? reply["answer"] : null);
  const listed = z.array(z.unknown()).safeParse(reply["citations"]);
  const citations = (listed.success ? listed.data : []).flatMap((item) => {
    const citation = Citation.safeParse(item);
    return citation.success ? [citation.data] : [];
  });
  const fields = Object.entries(reply)
    .filter(
      ([key, value]) =>
        key !== "citations" &&
        !(key === "answer" && value === answer) &&
        value !== null &&
        value !== undefined,
    )
    .map(([key, value]) => `${key}: ${plain(value)}`);
  const parts =
    run.status === "running"
      ? []
      : [
          run.seconds === undefined ? null : agentClock(run.seconds * 1000, false),
          run.cost === undefined
            ? null
            : `$${run.cost < 0.01 ? run.cost.toFixed(3) : run.cost.toFixed(2)}`,
        ];
  const meta = parts.filter((part) => part !== null).join(" · ");
  return {
    asked: asked.success
      ? asked.data.question
      : run.request === undefined
        ? null
        : plain(run.request),
    answer,
    citations,
    fields,
    meta: meta === "" ? null : meta,
  };
}
