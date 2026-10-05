import { beforeEach, describe, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string): Promise<string | null> => Promise.resolve(keychain.get(key) ?? null),
  setItemAsync: (key: string, value: string): Promise<void> => {
    keychain.set(key, value);
    return Promise.resolve();
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "device-id" }));

import {
  forgetPairedHost,
  getMostRecentPairedHost,
  getPairedHost,
  getPairedTargetNames,
  savePairedHost,
} from "./identity";

beforeEach(() => {
  keychain.clear();
});

describe("per-host credentials", () => {
  it("keeps independent trust when switching between two computers", async () => {
    await savePairedHost({ targetName: "work-mac", macName: "Work Mac", secretHex: "work-secret" });
    await savePairedHost({ targetName: "personal-mac", macName: "Personal Mac", secretHex: "personal-secret" });

    expect(await getPairedHost("work-mac")).toMatchObject({ secretHex: "work-secret" });
    expect(await getPairedHost("personal-mac")).toMatchObject({ secretHex: "personal-secret" });
    expect(await getPairedTargetNames()).toEqual(["work-mac", "personal-mac"]);
    expect(await getMostRecentPairedHost()).toMatchObject({ targetName: "personal-mac", secretHex: "personal-secret" });

    await forgetPairedHost("work-mac");
    expect(await getPairedHost("work-mac")).toBeNull();
    expect(await getPairedHost("personal-mac")).toMatchObject({ secretHex: "personal-secret" });
  });

  it("migrates the existing single-computer credential", async () => {
    keychain.set(
      "relay.pairedMac",
      JSON.stringify({ macName: "MacBook", secretHex: "legacy-secret", bonjourName: "MacBook.local" }),
    );

    expect(await getPairedHost("MacBook.local")).toEqual({
      targetName: "MacBook.local",
      macName: "MacBook",
      secretHex: "legacy-secret",
    });
    expect(keychain.has("relay.pairedHosts.v2")).toBe(true);
  });
});
