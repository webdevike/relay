/**
 * Pure words for a broken omp sign-in: the pill an assistant row shows (`agentHealth`) and the
 * "sign in again" guidance under a failed turn's error row (`signinGuidance`). The phone cannot run
 * the Mac's OAuth login, and the protocol has no phone-to-desktop open request (`control.req` is a
 * host frame only), so the fix is words plus the command to copy.
 */
import type { AssistantAgent, SigninFix } from "@relay/protocol";

export interface AgentHealth {
  label: string;
  tone: "danger" | "warn";
  /** One plain sentence for VoiceOver, when the host gave one. */
  detail?: string;
}

/** Relay's setup id for an omp provider (Settings > Connections names them "anthropic" and "openai"); null for one Relay has no setup row for. */
export function signinSetupId(provider: string): "anthropic" | "openai" | null {
  if (provider === "anthropic") return "anthropic";
  if (provider === "openai-codex") return "openai";
  return null;
}

/** The product name Settings > Connections shows for an omp provider. */
export function providerName(provider: string): string {
  if (provider === "anthropic") return "Claude";
  if (provider === "openai-codex") return "ChatGPT";
  return provider;
}

/** The terminal command that signs in `fix.provider` under the fix's profile (omp's default profile when none). */
export function signinCommand(fix: SigninFix): string {
  return fix.profile === undefined ? `omp login ${fix.provider}` : `omp --profile ${fix.profile} login ${fix.provider}`;
}

/** Where to sign in again, as one line: "Sign in again on your Mac: Relay > Settings > Connections > Claude (personal profile)". */
export function signinGuidance(fix: SigninFix): string {
  const where = signinSetupId(fix.provider) === null ? "a terminal" : `Relay > Settings > Connections > ${providerName(fix.provider)}`;
  const profile = fix.profile === undefined ? "" : ` (${fix.profile} profile)`;
  return `Sign in again on your Mac: ${where}${profile}`;
}

/**
 * What the Assistants list says instead of the status words when the agent cannot reply: a signed
 * out or missing sign-in, one shared with another profile, or a turn that failed with no reply
 * since. Null while all is well (or the host is from before `auth` and `failure`).
 */
export function agentHealth(agent: Pick<AssistantAgent, "auth" | "failure">): AgentHealth | null {
  const auth = agent.auth;
  if (auth !== undefined && auth.state !== "ok") {
    const label = auth.state === "shared" ? "Sign-in shared" : "Signed out";
    const tone = auth.state === "shared" ? "warn" : "danger";
    return auth.detail === undefined ? { label, tone } : { label, tone, detail: auth.detail };
  }
  if (agent.failure !== undefined) return { label: "Turn failed", tone: "danger", detail: agent.failure.text };
  return null;
}
