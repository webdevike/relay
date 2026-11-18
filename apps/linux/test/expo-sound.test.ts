import { describe, expect, it } from "vitest";
import { ExpoPushSender, RELAY_PUSH_SOUND } from "../src/push/expo";

const sent = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
  let body: unknown;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ data: [{ status: "ok", id: "t" }] }));
  }) as unknown as typeof fetch;
  await new ExpoPushSender(fetchImpl, "http://push.test").send([
    { to: "ExponentPushToken[x]", data: { withdraw: "a" }, ...message },
  ] as never);
  return (body as Record<string, unknown>[])[0]!;
};

describe("ExpoPushSender sound", () => {
  it("plays Relay's chime by default, and stays silent or custom when the message says so", async () => {
    expect((await sent({ title: "Nova", body: "done" })).sound).toBe(RELAY_PUSH_SOUND);
    expect((await sent({ sound: null })).sound).toBeNull();
    expect((await sent({ sound: "other.caf" })).sound).toBe("other.caf");
  });
});
