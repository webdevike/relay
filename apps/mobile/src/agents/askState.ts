import type { AgentAsk } from "@relay/protocol";

/** One answer per question: chosen option labels, or free text the user typed instead. */
export interface AskAnswer {
  id: string;
  selectedOptions: string[];
  customInput?: string;
}

/** What the card holds while the ask is open: the page shown, the picks and the typed answers, by question id. */
export interface AskDraft {
  step: number;
  selections: Record<string, string[]>;
  customs: Record<string, string>;
}

export type AskAction =
  /** An option tapped on page `index`: single-select replaces the pick, multi-select toggles it. */
  | { type: "pick"; index: number; label: string }
  /** The typed answer of page `index` changed; any text supersedes the picks. */
  | { type: "custom"; index: number; text: string }
  /** Moves on from page `from`; a no-op once the card is no longer on that page, so a late timer or a double tap never skips one. */
  | { type: "advance"; from: number }
  | { type: "back" }
  | { type: "goto"; index: number };

export const initialDraft: AskDraft = { step: 0, selections: {}, customs: {} };

/** Whether a question has an answer: a picked option or typed text. */
export function isAnswered(draft: AskDraft, id: string): boolean {
  return (draft.selections[id]?.length ?? 0) > 0 || (draft.customs[id]?.trim().length ?? 0) > 0;
}

/** The index of the first question still without an answer, or -1 when every one has one. */
export function firstUnanswered(ask: AgentAsk, draft: AskDraft): number {
  return ask.questions.findIndex((q) => !isAnswered(draft, q.id));
}

/** Whether tapping an option on page `index` moves to the next page by itself: single-select, not the last page. */
export function advancesOnPick(ask: AgentAsk, index: number): boolean {
  return ask.questions[index]?.multi !== true && index < ask.questions.length - 1;
}

export function reduceAsk(ask: AgentAsk, draft: AskDraft, action: AskAction): AskDraft {
  const last = ask.questions.length - 1;
  switch (action.type) {
    case "pick": {
      const question = ask.questions[action.index];
      if (question === undefined) return draft;
      const current = draft.selections[question.id] ?? [];
      const next =
        question.multi === true
          ? current.includes(action.label)
            ? current.filter((label) => label !== action.label)
            : [...current, action.label]
          : [action.label];
      return { ...draft, selections: { ...draft.selections, [question.id]: next }, customs: { ...draft.customs, [question.id]: "" } };
    }
    case "custom": {
      const question = ask.questions[action.index];
      if (question === undefined) return draft;
      return {
        ...draft,
        customs: { ...draft.customs, [question.id]: action.text },
        selections: action.text.length > 0 ? { ...draft.selections, [question.id]: [] } : draft.selections,
      };
    }
    case "advance":
      return draft.step === action.from ? { ...draft, step: Math.min(draft.step + 1, last) } : draft;
    case "back":
      return { ...draft, step: Math.max(0, draft.step - 1) };
    case "goto":
      return { ...draft, step: Math.max(0, Math.min(action.index, last)) };
  }
}

/** The answers to send: typed text wins over picks for a question, as on desktop. */
export function answersOf(ask: AgentAsk, draft: AskDraft): AskAnswer[] {
  return ask.questions.map((q) => {
    const custom = draft.customs[q.id]?.trim() ?? "";
    return custom.length > 0 ? { id: q.id, selectedOptions: [], customInput: custom } : { id: q.id, selectedOptions: draft.selections[q.id] ?? [] };
  });
}
