/**
 * The cards of an assistant thread's card stack (`agents/CardStack`), in order: what the thread's
 * session is blocked on (its tool approval, else its omp ask form), then the open asks oldest first,
 * then what runs for the thread (`lib/activity.ts` `runningCards`, waiting ones first). Each card's
 * id is the one Relay desktop's stack uses where both have it (`ask:<open ask id>`, `run:<item id>`).
 * No React Native imports.
 */
import type { AgentApproval, AgentAsk, OpenAsk } from "@relay/protocol";
import { defaultNote } from "./openAsks";
import type { RunningCard } from "./activity";

export type StackCard =
  | { kind: "approval"; id: string; title: string; sessionId: string; approval: AgentApproval }
  | { kind: "form"; id: string; title: string; ask: AgentAsk }
  | { kind: "question"; id: string; title: string; detail: string | null; ask: OpenAsk }
  | { kind: "running"; id: string; title: string; run: RunningCard };

export interface StackSources {
  /** The thread's omp session, with the tool call it waits on Isaac to approve. */
  approval: { sessionId: string; approval: AgentApproval } | null;
  /** The omp ask form the thread's session is blocked on (`usePendingAsk`); shown only without an approval, as before. */
  form: AgentAsk | null;
  /** The open asks to show (`visibleAsks`: already without the form's own ask and the ones closed here). */
  asks: readonly OpenAsk[];
  running: readonly RunningCard[];
}

/** An omp ask form's title: its one question's header (else the question), or how many it asks. */
function formTitle(ask: AgentAsk): string {
  const only = ask.questions.length === 1 ? ask.questions[0] : undefined;
  if (only === undefined) return `${String(ask.questions.length)} questions`;
  return only.header !== undefined && only.header !== "" ? only.header : only.question;
}

/** The line under an open ask's title: the whole question when the title is its label, and a session ask's default. */
function questionDetail(ask: OpenAsk): string | null {
  const lines = [ask.question === ask.label ? null : ask.question, defaultNote(ask)].filter((line) => line !== null);
  return lines.length === 0 ? null : lines.join("\n");
}

export function stackCards({ approval, form, asks, running }: StackSources): StackCard[] {
  const blocking: StackCard[] =
    approval !== null
      ? [{ kind: "approval", id: `approval:${approval.sessionId}`, title: `Allow ${approval.approval.toolName}?`, ...approval }]
      : form !== null
        ? [{ kind: "form", id: `askcard:${form.id}`, title: formTitle(form), ask: form }]
        : [];
  const questions: StackCard[] = [...asks]
    .sort((a, b) => a.at - b.at)
    .map((ask) => ({ kind: "question", id: `ask:${ask.id}`, title: ask.label, detail: questionDetail(ask), ask }));
  const runs: StackCard[] = running.map((run) => ({ kind: "running", id: `run:${run.id}`, title: run.title, run }));
  return [...blocking, ...questions, ...runs];
}
