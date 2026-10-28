import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@relay/protocol";
import { handleAgentReaction } from "../src/reactions/http";
import type { ReactionRelaying } from "../src/reactions/service";
import type { AssistantRelaying, AssistantThread } from "../src/seams";

const messages: AssistantMessage[] = [
  { id: "1", role: "user", text: "first", at: 100 },
  { id: "2", role: "assistant", text: "reply", at: 200 },
  { id: "3", role: "user", text: "<surface>phone - Relay</surface>\nmoved the dentist", at: 300 },
  { id: "4", role: "assistant", text: "nice", at: 400 },
];

function setup() {
  const calls: string[] = [];
  const reactions: ReactionRelaying = {
    snapshot: () => ({}),
    set: (thread, key, emoji, excerpt, by) => (calls.push(`set ${thread} ${key} ${emoji} ${excerpt} ${by ?? "-"}`), true),
    clear: (thread, key, by) => (calls.push(`clear ${thread} ${key} ${by ?? "-"}`), true),
    observe: () => undefined,
  };
  const nova = { id: "nova", title: "Nova", snapshot: () => Promise.resolve({ rev: 1, messages, busy: false, sessionId: "s" }) } as unknown as AssistantThread;
  const assistant = { threads: [nova], thread: (id?: string) => (id === "nova" ? nova : undefined) } as unknown as AssistantRelaying;
  const post = (body: unknown, remote = "127.0.0.1") =>
    handleAgentReaction(reactions, assistant, new Request("http://127.0.0.1/reactions/agent", { method: "POST", body: JSON.stringify(body) }), remote);
  return { calls, post };
}

describe("POST /reactions/agent", () => {
  it("reacts as the agent to Isaac's newest message by default, or a named one, and clears", async () => {
    const { calls, post } = setup();
    const latest = await post({ agent: "nova", emoji: "👍" });
    expect(await latest.json()).toEqual({ thread: "assistant:nova", message: "user@300", emoji: "👍" });
    expect((await post({ agent: "nova", emoji: "❤️", message: "user@100" })).status).toBe(200);
    expect((await post({ agent: "nova", clear: true })).status).toBe(200);
    expect(calls).toEqual(["set assistant:nova user@300 👍 moved the dentist nova", "set assistant:nova user@100 ❤️ first nova", "clear assistant:nova user@300 nova"]);
  });

  it("refuses its own messages, unknown bubbles and agents, Isaac's name, missing emoji and remote callers", async () => {
    const { calls, post } = setup();
    expect((await post({ agent: "nova", emoji: "👍", message: "assistant@200" })).status).toBe(400);
    expect((await post({ agent: "nova", emoji: "👍", message: "user@999" })).status).toBe(404);
    expect((await post({ agent: "zed", emoji: "👍" })).status).toBe(400);
    expect((await post({ agent: "isaac", emoji: "👍" })).status).toBe(400);
    expect((await post({ agent: "nova" })).status).toBe(400);
    expect((await post({ agent: "nova", emoji: "yes" })).status).toBe(400);
    expect((await post({ agent: "nova", emoji: "👍" }, "100.64.0.9")).status).toBe(403);
    expect(calls).toEqual([]);
  });
});
