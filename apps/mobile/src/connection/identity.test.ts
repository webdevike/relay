import { beforeEach, describe, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => new Map<string, string>());
const documents = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string): Promise<string | null> => Promise.resolve(keychain.get(key) ?? null),
  setItemAsync: (key: string, value: string): Promise<void> => {
    keychain.set(key, value);
    return Promise.resolve();
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "device-id" }));
vi.mock("expo-file-system", () => ({
  File: class {
    readonly name: string;

    constructor(_directory: unknown, name: string) {
      this.name = name;
    }

    get exists(): boolean {
      return documents.has(this.name);
    }

    text(): Promise<string> {
      return Promise.resolve(documents.get(this.name) ?? "");
    }

    delete(): void {
      documents.delete(this.name);
    }
  },
  Paths: { document: "documents" },
}));

import {
  forgetPairedHost,
  getMostRecentPairedHost,
  getPairedHost,
  getPairedTargetNames,
  importProvisionedHost,
  savePairedHost,
} from "./identity";

beforeEach(() => {
  keychain.clear();
  documents.clear();
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

  it("imports physically provisioned trust into Keychain and deletes the transfer file", async () => {
    const secretHex = "ab".repeat(32);
    documents.set(
      "relay-quick-trust.json",
      JSON.stringify({
        deviceId: "device-id",
        targetName: "192.168.4.80:7817",
        macName: "Work Mac",
        secretHex,
      }),
    );

    expect(await importProvisionedHost("device-id")).toBe(true);
    expect(await getPairedHost("192.168.4.80:7817")).toMatchObject({ secretHex });
    expect(documents.has("relay-quick-trust.json")).toBe(false);
  });
});
