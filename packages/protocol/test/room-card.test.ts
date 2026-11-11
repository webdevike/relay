import { describe, expect, it } from "vitest";
import { roomCardFallback, splitRoomCards } from "../src/room-card";

describe("splitRoomCards", () => {
  it("cuts the token lines and returns the rooms in order, each once", () => {
    const r = splitRoomCards("Done. Nobody starts until you speak.\n[[room:room-abc-1 | Boxhead weapon system]]\n\nAnd [[room:room-x]] here.\n[[room:room-abc-1]]");
    expect(r.text).toBe("Done. Nobody starts until you speak.\n\nAnd here.");
    expect(r.rooms).toEqual([{ id: "room-abc-1", title: "Boxhead weapon system" }, { id: "room-x" }]);
  });

  it("leaves text without a token, and tokens in code fences, as they are", () => {
    for (const t of ["plain [[pin: a | b]]", "```\n[[room:room-1]]\n```", "[[room:Bad Id]]"]) expect(splitRoomCards(t)).toEqual({ text: t, rooms: [] });
  });

  it("hides a token still arriving while the reply streams, and only then", () => {
    expect(splitRoomCards("ok\n[[room:room-a", true).text).toBe("ok");
    expect(splitRoomCards("ok\n[[ro", true).text).toBe("ok");
    expect(splitRoomCards("ok\n[[ro", false).text).toBe("ok\n[[ro");
  });

  it("falls back to Room: <title>", () => {
    expect(roomCardFallback({ id: "r", title: "Godot or Unreal" })).toBe("Room: Godot or Unreal");
    expect(roomCardFallback({ id: "r" })).toBe("Room");
  });
});
