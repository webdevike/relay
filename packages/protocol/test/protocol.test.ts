import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import client from "../fixtures/client-messages.json";
import server from "../fixtures/server-messages.json";
import { authProof, fromHex, hmacSha256, parseClientMessage, parseServerMessage, toHex } from "../src";

const sha256 = (d: Uint8Array) => webcrypto.subtle.digest("SHA-256", d);

describe("fixtures", () => {
  it("every client fixture parses and round-trips", () => {
    for (const m of client) {
      const r = parseClientMessage(JSON.stringify(m));
      expect(r.ok, JSON.stringify(m)).toBe(true);
      if (r.ok) expect(r.value).toEqual(m);
    }
  });
  it("every server fixture parses and round-trips", () => {
    for (const m of server) {
      const r = parseServerMessage(JSON.stringify(m));
      expect(r.ok, JSON.stringify(m)).toBe(true);
      if (r.ok) expect(r.value).toEqual(m);
    }
  });
});

describe("rejections", () => {
  it("rejects wrong protocol version, malformed pin, empty input batch, and cross-direction frames", () => {
    expect(parseClientMessage(JSON.stringify({ t: "hello", v: 2, deviceId: "d", deviceName: "n", platform: "ios" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "pair.confirm", pin: "12345" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "input", events: [] })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "welcome" })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "cmd", id: "x", cmd: { kind: "key.press", key: "return" } })).ok).toBe(false);
    expect(parseServerMessage("{not json").ok).toBe(false);
  });
});

describe("hmac", () => {
  it("matches RFC 4231 test case 2", async () => {
    const mac = await hmacSha256(new TextEncoder().encode("Jefe"), new TextEncoder().encode("what do ya want for nothing?"), sha256);
    expect(toHex(mac)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });
  it("authProof is deterministic and keyed", async () => {
    const secret = toHex(new Uint8Array(32).fill(7));
    const a = await authProof(secret, "nonce-1", sha256);
    expect(a).toBe(await authProof(secret, "nonce-1", sha256));
    expect(a).not.toBe(await authProof(secret, "nonce-2", sha256));
    expect(a).not.toBe(await authProof(toHex(new Uint8Array(32).fill(8)), "nonce-1", sha256));
  });
  it("hex helpers reject odd or non-hex input", () => {
    expect(() => fromHex("abc")).toThrow();
    expect(() => fromHex("zz")).toThrow();
    expect(toHex(fromHex("00ff10"))).toBe("00ff10");
  });
});
