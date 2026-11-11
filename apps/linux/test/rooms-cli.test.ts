import { describe, expect, it } from "vitest";
import { roomsControlRequest, roomsOutput } from "../src/control/rooms-cli";

const stdin = (text: string) => () => Promise.resolve(text);

describe("relay-linux rooms", () => {
  it("create sends rooms.create as the calling assistant, JSON from the argument or stdin", async () => {
    const setup = { members: [{ custom: "Sol", model: "openai/gpt-6-sol", thinking: "medium", role: "Critic" }], effort: 2, budget: 3 };
    expect(await roomsControlRequest({ verb: "create", args: [JSON.stringify(setup)], stdin: stdin(""), assistant: "nova", device: undefined })).toEqual({
      action: "rooms.create",
      scope: "agent:nova",
      params: setup,
    });
    expect(await roomsControlRequest({ verb: "create", args: ["-"], stdin: stdin(JSON.stringify(setup)), assistant: undefined, device: "MacBook" })).toEqual({
      action: "rooms.create",
      target: "MacBook",
      params: setup,
    });
  });

  it("update puts the room id in the params; list sends nothing else", async () => {
    expect(await roomsControlRequest({ verb: "update", args: ["room-1", '{"budget":5}'], stdin: stdin(""), assistant: "nova", device: undefined })).toEqual({
      action: "rooms.update",
      scope: "agent:nova",
      params: { budget: 5, roomId: "room-1" },
    });
    expect(await roomsControlRequest({ verb: "list", args: [], stdin: stdin(""), assistant: undefined, device: undefined })).toEqual({ action: "rooms.list", params: {} });
  });

  it("refuses a missing verb, room id or JSON object", async () => {
    await expect(roomsControlRequest({ verb: undefined, args: [], stdin: stdin(""), assistant: undefined, device: undefined })).rejects.toThrow(/create, update or list/);
    await expect(roomsControlRequest({ verb: "update", args: ['{"budget":5}'], stdin: stdin(""), assistant: undefined, device: undefined })).rejects.toThrow(/missing <roomId>/);
    await expect(roomsControlRequest({ verb: "create", args: ["not json"], stdin: stdin(""), assistant: undefined, device: undefined })).rejects.toThrow(/not JSON/);
    await expect(roomsControlRequest({ verb: "create", args: ["[1]"], stdin: stdin(""), assistant: undefined, device: undefined })).rejects.toThrow(/JSON object/);
  });

  it("prints the answer and what to post, or the refusal", () => {
    const ok = roomsOutput("rooms.create", { ok: true, value: { roomId: "room-1", card: "[[room:room-1]]", next: "Put [[room:room-1]] on its own line" } });
    expect(ok.ok).toBe(true);
    expect(ok.lines.at(-1)).toBe("Put [[room:room-1]] on its own line");
    expect(roomsOutput("rooms.create", { ok: false, code: "bad-input", message: "budget $12 is over $10" })).toEqual({ ok: false, lines: ["bad-input: budget $12 is over $10"] });
  });
});
