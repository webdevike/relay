import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_DISMISSED_CARDS, type ServerMessage } from "@relay/protocol";
import { DismissedCardService } from "../src/cards/service";

let dir: string;
let sent: ServerMessage[];
const make = (path = join(dir, "dismissed-cards.json")): DismissedCardService =>
  new DismissedCardService({
    path,
    broadcast: (m) => {
      sent.push(m);
    },
    log: () => undefined,
  });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-cards-"));
  sent = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("DismissedCardService", () => {
  it("dismisses and restores a card, broadcasting the whole set each time and nothing on a no-op", () => {
    const service = make();
    expect(service.snapshot()).toEqual([]);
    expect(service.set("canvas:m1", true)).toBe(true);
    expect(service.set("work:w1#running", true)).toBe(true);
    expect(service.set("canvas:m1", true)).toBe(false);
    expect(service.set("room:r:ready", false)).toBe(false);
    expect(service.set("canvas:m1", false)).toBe(true);
    expect(service.snapshot()).toEqual(["work:w1#running"]);
    expect(sent).toEqual([
      { t: "cards.dismissed", ids: ["canvas:m1"] },
      { t: "cards.dismissed", ids: ["canvas:m1", "work:w1#running"] },
      { t: "cards.dismissed", ids: ["work:w1#running"] },
    ]);
  });

  it("refuses an empty or oversized id", () => {
    const service = make();
    expect(service.set("", true)).toBe(false);
    expect(service.set("x".repeat(201), true)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("persists privately and comes back after a restart", () => {
    const path = join(dir, "sub", "dismissed-cards.json");
    make(path).set("meeting:r1", true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(make(path).snapshot()).toEqual(["meeting:r1"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ids: ["meeting:r1"] });
  });

  it("starts empty from an unreadable or foreign file", () => {
    const path = join(dir, "dismissed-cards.json");
    writeFileSync(path, "{nope");
    expect(make(path).snapshot()).toEqual([]);
    writeFileSync(path, JSON.stringify({ ids: [7] }));
    expect(make(path).snapshot()).toEqual([]);
  });

  it("keeps the newest MAX_DISMISSED_CARDS", () => {
    const service = make();
    for (let i = 0; i < MAX_DISMISSED_CARDS + 2; i++) service.set(`work:${i}`, true);
    const ids = service.snapshot();
    expect(ids).toHaveLength(MAX_DISMISSED_CARDS);
    expect(ids[0]).toBe("work:2");
  });
});
