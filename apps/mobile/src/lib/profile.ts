/**
 * The phone's Work | Personal scope: one omp account at a time. A session belongs to the account
 * it runs on (`AgentSession.account`, read the way `accountLabel` reads it: profile "personal" is
 * Personal, every other profile, "current" included, is Work). A session without an account
 * (providers without accounts, older hosts) belongs to neither, so it stays visible in both.
 * An assistant's account is the account of the session it runs in (`kind` "assistant").
 */
import type { AgentAccount, AgentSession, AssistantAgent } from "@relay/protocol";

export type OmpProfile = "work" | "personal";

export const PROFILE_TABS: readonly { key: OmpProfile; label: string }[] = [
  { key: "work", label: "Work" },
  { key: "personal", label: "Personal" },
];

/** A stored profile from any build: "personal" stays Personal; "", "current" and anything else is Work. */
export function normalizeProfile(value: unknown): OmpProfile {
  return value === "personal" ? "personal" : "work";
}

/** The scope an account falls in; null when there is no account. */
export function accountProfile(account: AgentAccount | undefined): OmpProfile | null {
  if (account === undefined) return null;
  return account.profile === "personal" ? "personal" : "work";
}

/** Whether a session shows under `profile`: its account matches, or it has none. */
export function inProfile(session: Pick<AgentSession, "account">, profile: OmpProfile): boolean {
  const kind = accountProfile(session.account);
  return kind === null || kind === profile;
}

/** `order` narrowed to the sessions that show under `profile`, keeping its order. */
export function scopeOrder(order: readonly string[], sessions: Record<string, AgentSession>, profile: OmpProfile): string[] {
  return order.filter((id) => {
    const session = sessions[id];
    return session !== undefined && inProfile(session, profile);
  });
}

/** The registry with the agents running under `profile` first; otherwise the host's order holds. */
export function orderAssistants(
  agents: readonly AssistantAgent[],
  sessions: Record<string, AgentSession>,
  profile: OmpProfile,
): AssistantAgent[] {
  const profiles = new Map<string, OmpProfile | null>();
  for (const session of Object.values(sessions)) {
    if (session.kind === "assistant" && session.assistant !== undefined) profiles.set(session.assistant, accountProfile(session.account));
  }
  const matches = (agent: AssistantAgent): number => (profiles.get(agent.id) === profile ? 0 : 1);
  return [...agents].sort((a, b) => matches(a) - matches(b));
}
