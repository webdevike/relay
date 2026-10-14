/**
 * Answering an agent that is blocked on Isaac, from a lock-screen notification action or from the
 * in-app approval card. Pure apart from the injected `AnswerDeps`, so the rules are testable
 * without a phone: an ordinary approval is one tap, a destructive one (`requiresBiometric`) needs
 * Face ID first and is sent as `confirmed: "biometric"`, a denial never needs anything, and an ask
 * is answered with one of its options or the typed text. There is no "always allow" anywhere.
 */
import { z } from "zod";
import type { Command } from "@relay/protocol";

/** Notification action identifiers, registered in `categories.ts`. */
export const ACTION = {
  approve: "relay.approve",
  deny: "relay.deny",
  answer: "relay.answer",
  open: "relay.open",
} as const;

/** What an inbox push carries so a killed app can answer it (`apps/linux/src/inbox/service.ts`, `InboxPushData`). */
const InboxData = z.object({
  id: z.string().min(1),
  kind: z.enum(["approval", "ask", "alert"]),
  sessionId: z.string().min(1).optional(),
  approvalId: z.string().min(1).optional(),
  requiresBiometric: z.boolean().optional(),
  destructive: z.string().min(1).optional(),
  askId: z.string().min(1).optional(),
  questionId: z.string().min(1).optional(),
  options: z.array(z.string()).optional(),
});
export type InboxNotificationData = z.infer<typeof InboxData>;

/** The inbox payload of a notification's `data`, or null for any other notification. */
export function parseInboxData(data: unknown): InboxNotificationData | null {
  const parsed = InboxData.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * Maps typed text onto an ask's options: an exact label (any case), or the option's 1-based number,
 * picks it; anything else is sent as the typed answer (omp's ask always takes free text).
 */
export function pickOption(options: readonly string[], text: string): { selectedOptions: string[]; customInput?: string } {
  const typed = text.trim();
  const byLabel = options.find((label) => label.toLowerCase() === typed.toLowerCase());
  if (byLabel !== undefined) return { selectedOptions: [byLabel] };
  const index = /^[1-9]$/.test(typed) ? Number(typed) - 1 : -1;
  const byNumber = options[index];
  if (byNumber !== undefined) return { selectedOptions: [byNumber] };
  return { selectedOptions: [], customInput: typed };
}

export type Outcome =
  | { status: "sent" }
  /** Face ID was declined or unavailable; nothing was sent and the agent is still blocked. */
  | { status: "cancelled" }
  | { status: "offline" }
  | { status: "failed"; message: string }
  /** Not an answer to anything (an `Open` tap, an alert, missing fields). */
  | { status: "ignored" };

export interface AnswerDeps {
  /** Face ID (biometrics only, no passcode fallback); true when the person was recognised. */
  authenticate: (reason: string) => Promise<boolean>;
  /** Wakes the connection and resolves true once the host is reachable, false on timeout. */
  whenConnected: () => Promise<boolean>;
  send: (cmd: Command) => Promise<void>;
}

export interface ApprovalTarget {
  sessionId: string;
  approvalId: string;
  requiresBiometric: boolean;
  /** The destructive pattern, for the Face ID prompt ("force push"). */
  destructive?: string | undefined;
}

async function deliver(cmd: Command, deps: AnswerDeps): Promise<Outcome> {
  if (!(await deps.whenConnected())) return { status: "offline" };
  try {
    await deps.send(cmd);
    return { status: "sent" };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function approve(target: ApprovalTarget, deps: AnswerDeps): Promise<Outcome> {
  const base = { kind: "agent.approve", sessionId: target.sessionId, approvalId: target.approvalId } as const;
  if (!target.requiresBiometric) return deliver(base, deps);
  if (!(await deps.authenticate(`Approve ${target.destructive ?? "this destructive action"}`))) return { status: "cancelled" };
  return deliver({ ...base, confirmed: "biometric" }, deps);
}

export function deny(target: Pick<ApprovalTarget, "sessionId" | "approvalId">, deps: AnswerDeps): Promise<Outcome> {
  return deliver({ kind: "agent.deny", sessionId: target.sessionId, approvalId: target.approvalId }, deps);
}

/** Runs the notification action `action` (with `userText` for the ask's text field) on `data`. */
export async function answerFromNotification(data: InboxNotificationData, action: string, userText: string | undefined, deps: AnswerDeps): Promise<Outcome> {
  const { sessionId } = data;
  if (sessionId === undefined) return { status: "ignored" };
  if (data.kind === "approval" && data.approvalId !== undefined) {
    const target = { sessionId, approvalId: data.approvalId, requiresBiometric: data.requiresBiometric ?? true, destructive: data.destructive };
    if (action === ACTION.approve) return approve(target, deps);
    if (action === ACTION.deny) return deny(target, deps);
    return { status: "ignored" };
  }
  if (data.kind === "ask" && data.askId !== undefined && data.questionId !== undefined && action === ACTION.answer) {
    const text = userText?.trim() ?? "";
    if (text.length === 0) return { status: "ignored" };
    const results = [{ id: data.questionId, ...pickOption(data.options ?? [], text) }];
    return deliver({ kind: "agent.ask.answer", sessionId, askId: data.askId, results }, deps);
  }
  return { status: "ignored" };
}

/**
 * The id of the inbox notification a silent withdraw push names. Expo wraps a message's `data` in
 * the APNs payload (under `body`, `data` or `notification.data`, sometimes as a JSON string), so
 * this looks for the `withdraw` key at any of those depths rather than trusting one shape.
 */
export function withdrawIdOf(payload: unknown, depth = 0): string | null {
  if (depth > 4 || payload === null || payload === undefined) return null;
  if (typeof payload === "string") {
    if (!payload.startsWith("{")) return null;
    try {
      return withdrawIdOf(JSON.parse(payload) as unknown, depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const direct = record["withdraw"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const value of Object.values(record)) {
    const found = withdrawIdOf(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}
