// Expo push service client: one POST per batch, tickets mapped back onto the messages.
// https://docs.expo.dev/push-notifications/sending-notifications/

import { z } from "zod";
import type { PushMessage, PushOutcome, PushSender } from "./notifier";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

const Ticket = z.union([
  z.object({ status: z.literal("ok"), id: z.string() }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    details: z.object({ error: z.string().optional() }).optional(),
  }),
]);
const Response = z.object({ data: z.array(Ticket) });

export class ExpoPushSender implements PushSender {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(messages: readonly PushMessage[]): Promise<readonly PushOutcome[]> {
    const response = await this.fetchImpl(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "gzip, deflate" },
      body: JSON.stringify(messages.map((message) => ({ ...message, sound: "default", priority: "high" }))),
    });
    if (!response.ok) throw new Error(`expo push: HTTP ${response.status}`);
    const parsed = Response.safeParse(await response.json());
    if (!parsed.success) throw new Error("expo push: unexpected response shape");
    return parsed.data.data.map((ticket) =>
      ticket.status === "ok" ? { ok: true } : { ok: false, error: ticket.message, unregistered: ticket.details?.error === "DeviceNotRegistered" },
    );
  }
}
