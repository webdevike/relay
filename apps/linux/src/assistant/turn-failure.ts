// What an assistant thread says about a failed turn: the error row the phone shows, the failure on
// the agent's `assistant.agents` row (Relay desktop draws it at the end of the chat and on the
// sidebar), and the one-tap fix for a sign-in problem (sign in again under the agent's own omp
// profile: a login under another profile never reaches it, 2026-11-19).

import type { AssistantMessage, SigninFix, TurnFailure, TurnFailureKind } from "@relay/protocol";

/** A failed turn as a transcript row says it (`AgentMessage.error`, or the host's own for "exit"). */
export interface FailedTurn {
  readonly kind: TurnFailureKind;
  readonly provider?: string | undefined;
  readonly prompt?: string | undefined;
}

/** The agent a failure is about: its title, omp profile (absent: default) and the provider of its registry model. */
export interface FailingAgent {
  readonly title: string;
  readonly profile?: string;
  readonly provider?: string;
}

/** A provider as Isaac knows it: Claude, ChatGPT, else omp's id. */
export function providerName(provider: string): string {
  if (provider === "anthropic") return "Claude";
  if (provider === "openai-codex") return "ChatGPT";
  return provider;
}

/** The omp provider of a registry model (`anthropic/claude-opus-5-5:high` -> `anthropic`); undefined without one. */
export function providerOfModel(model: string | undefined): string | undefined {
  const slash = model?.indexOf("/") ?? -1;
  return model === undefined || slash <= 0 ? undefined : model.slice(0, slash);
}

/** "the personal profile" / "the default profile". */
export function profileLabel(profile: string | undefined): string {
  return `the ${profile ?? "default"} profile`;
}

/** The sign-in fix for `provider` under the agent's profile. */
export function signinFix(provider: string, profile: string | undefined): SigninFix {
  return { kind: "signin", provider, ...(profile === undefined ? {} : { profile }) };
}

/** The first sentence of omp's error, without its closing period ("No API key found for anthropic"); omp follows it with generic advice the row replaces. */
export function firstSentence(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  const end = flat.search(/\.(\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end);
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}

/** Title, plain-words text and fix of a failed turn of `agent`; `error` is omp's error (or the host's, for "exit"). */
export function describeFailure(
  agent: FailingAgent,
  error: FailedTurn,
  message: string,
): { title: string; text: string; fix?: SigninFix } {
  const reason = firstSentence(message);
  const lost = error.prompt === undefined ? "" : `Your message didn't reach ${agent.title}: "${error.prompt}". `;
  const provider = error.provider ?? agent.provider;
  const service = provider === undefined ? "Its AI account" : providerName(provider);
  const title = error.kind === "exit" ? `${agent.title} stopped` : `${agent.title} couldn't reply`;
  switch (error.kind) {
    case "auth":
      return {
        title,
        text: `${lost}${service} sign-in for ${profileLabel(agent.profile)} isn't working (${reason}). Sign in again, then send it again.`,
        ...(provider === undefined ? {} : { fix: signinFix(provider, agent.profile) }),
      };
    case "rate_limit":
      return {
        title,
        text: `${lost}${service} turned it down for a rate or usage limit (${reason}). Try again later, or switch ${agent.title} to another model.`,
      };
    case "model":
      return { title, text: `${lost}The model ended the turn with an error: ${message.replace(/\s+/g, " ").trim()}` };
    case "exit":
      return {
        title,
        text: `${agent.title}'s omp stopped in the middle of a turn (${reason}). Your next message starts it again.`,
      };
  }
}

/** The phone's error row for failed-turn row `row` of `agent`. */
export function errorRow(
  agent: FailingAgent,
  row: { readonly id: string; readonly at: number; readonly text: string; readonly error: FailedTurn },
): AssistantMessage {
  const said = describeFailure(agent, row.error, row.text);
  return {
    id: row.id,
    role: "error",
    title: said.title,
    text: said.text,
    at: row.at,
    failure: row.error.kind,
    ...(said.fix === undefined ? {} : { fix: said.fix }),
  };
}

/**
 * The newest failed turn of a thread (its rows as the phone shows them) that nothing has answered
 * since: the newest row that is Isaac's, the agent's or an error, if it is an error. A turn he sent
 * after it (still running) or a reply clears it.
 */
export function pendingFailure(messages: readonly AssistantMessage[]): TurnFailure | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row === undefined) continue;
    if (row.role === "user" || row.role === "assistant") return undefined;
    if (row.role !== "error" || row.failure === undefined) continue;
    return {
      at: row.at,
      kind: row.failure,
      title: row.title ?? "",
      text: row.text,
      ...(row.fix === undefined ? {} : { fix: row.fix }),
    };
  }
  return undefined;
}
