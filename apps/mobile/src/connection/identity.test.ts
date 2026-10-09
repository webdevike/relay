import { beforeEach, describe, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => new Map<string, string>());
const documents = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string): Promise<string | null> => Promise.resolve(keychain.get(key) ?? null),
  setItemAsync: (key: string, value: string): Promise<void> => {
    keychain.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key: string): Promise<void> => {
    keychain.delete(key);
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

vi.mock("@/state/storage", () => ({ fileStorage: { getItem: () => Promise.resolve(null) } }));

import { importProvisionedHost, loadPairedHosts } from "./identity";

beforeEach(() => {
  keychain.clear();
  documents.clear();
});

describe("paired hosts storage", () => {
  it("migrates the quick-connect per-target list and the single-computer credential together", async () => {
    keychain.set("relay.pairedHosts.v2", JSON.stringify([{ targetName: "192.168.4.80:7817", macName: "Work Mac", secretHex: "work" }]));
    keychain.set("relay.pairedMac", JSON.stringify({ macName: "MacBook", secretHex: "legacy", bonjourName: "MacBook.local" }));

    const hosts = await loadPairedHosts();
    expect(hosts.hosts.map((host) => [host.id, host.secretHex])).toEqual([
      ["192.168.4.80:7817", "work"],
      ["MacBook.local", "legacy"],
    ]);
    expect(keychain.has("relay.pairedMac")).toBe(false);
    expect(keychain.has("relay.pairedHosts.v2")).toBe(false);
  });

  it("imports physically provisioned trust as the active host and deletes the transfer file", async () => {
    const secretHex = "ab".repeat(32);
    keychain.set("relay.hosts", JSON.stringify({ activeId: "MacBook", hosts: [{ id: "MacBook", name: "MacBook", address: "", secretHex: "other" }] }));
    documents.set("relay-quick-trust.json", JSON.stringify({ deviceId: "device-id", targetName: "192.168.4.80:7817", macName: "Work Mac", secretHex }));

    expect(await importProvisionedHost("device-id")).toBe(true);
    const hosts = await loadPairedHosts();
    expect(hosts.activeId).toBe("192.168.4.80:7817");
    expect(hosts.hosts).toHaveLength(2);
    expect(documents.has("relay-quick-trust.json")).toBe(false);
  });
});
