/**
 * Device identity and per-host credentials, backed by expo-secure-store (iOS Keychain).
 * Secrets leave this module only as input to `authProof`. They are never logged or persisted
 * outside Keychain.
 */
import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";

const DEVICE_ID_KEY = "relay.deviceId";
const PAIRED_HOSTS_KEY = "relay.pairedHosts.v2";
const LEGACY_PAIRED_MAC_KEY = "relay.pairedMac";
const QUICK_TRUST_FILE = "relay-quick-trust.json";

export interface PairedHost {
  readonly targetName: string;
  readonly macName: string;
  readonly secretHex: string;
}

let cachedDeviceId: string | null = null;

/** Stable per-install device id. Created once on first call and persisted thereafter. */
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId !== null) return cachedDeviceId;
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing !== null) {
    cachedDeviceId = existing;
    return existing;
  }
  const created = randomUUID();
  await SecureStore.setItemAsync(DEVICE_ID_KEY, created);
  cachedDeviceId = created;
  return created;
}

/**
 * Imports trust provisioned through the iOS app-data channel by a physically paired computer.
 * The plaintext transfer file is deleted after import; the credential then lives only in Keychain.
 */
export async function importProvisionedHost(deviceId: string): Promise<boolean> {
  const file = new File(Paths.document, QUICK_TRUST_FILE);
  if (!file.exists) return false;

  const provision = parseProvisionedHost(await file.text());
  if (provision?.deviceId !== deviceId) {
    file.delete();
    return false;
  }
  await savePairedHost({
    targetName: provision.targetName,
    macName: provision.macName,
    secretHex: provision.secretHex,
  });
  file.delete();
  return true;
}

export async function getPairedHost(targetName: string): Promise<PairedHost | null> {
  const hosts = await loadPairedHosts();
  return hosts.find((host) => host.targetName === targetName) ?? null;
}

export async function getMostRecentPairedHost(): Promise<PairedHost | null> {
  const hosts = await loadPairedHosts();
  return hosts[hosts.length - 1] ?? null;
}

export async function getPairedTargetNames(): Promise<string[]> {
  return (await loadPairedHosts()).map((host) => host.targetName);
}

export async function savePairedHost(host: PairedHost): Promise<void> {
  const hosts = await loadPairedHosts();
  await persistPairedHosts([...hosts.filter((candidate) => candidate.targetName !== host.targetName), host]);
}

export async function forgetPairedHost(targetName: string): Promise<void> {
  const hosts = await loadPairedHosts();
  await persistPairedHosts(hosts.filter((host) => host.targetName !== targetName));
}

async function loadPairedHosts(): Promise<PairedHost[]> {
  const stored = parsePairedHosts(await SecureStore.getItemAsync(PAIRED_HOSTS_KEY));
  if (stored !== null) return stored;

  const legacy = parseLegacyPairedMac(await SecureStore.getItemAsync(LEGACY_PAIRED_MAC_KEY));
  if (legacy === null) return [];
  const migrated = [{ targetName: legacy.bonjourName, macName: legacy.macName, secretHex: legacy.secretHex }];
  await persistPairedHosts(migrated);
  return migrated;
}

async function persistPairedHosts(hosts: readonly PairedHost[]): Promise<void> {
  await SecureStore.setItemAsync(PAIRED_HOSTS_KEY, JSON.stringify(hosts));
}

function parsePairedHosts(raw: string | null): PairedHost[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every(isPairedHost)) return [];
    return value;
  } catch {
    return [];
  }
}

function parseLegacyPairedMac(raw: string | null): { macName: string; secretHex: string; bonjourName: string } | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record["macName"] !== "string" ||
      typeof record["secretHex"] !== "string" ||
      typeof record["bonjourName"] !== "string"
    ) {
      return null;
    }
    return {
      macName: record["macName"],
      secretHex: record["secretHex"],
      bonjourName: record["bonjourName"],
    };
  } catch {
    return null;
  }
}

function parseProvisionedHost(raw: string): (PairedHost & { readonly deviceId: string }) | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record["deviceId"] !== "string" ||
      typeof record["targetName"] !== "string" ||
      typeof record["macName"] !== "string" ||
      typeof record["secretHex"] !== "string" ||
      !/^[0-9a-f]{64}$/.test(record["secretHex"])
    ) {
      return null;
    }
    return {
      deviceId: record["deviceId"],
      targetName: record["targetName"],
      macName: record["macName"],
      secretHex: record["secretHex"],
    };
  } catch {
    return null;
  }
}

function isPairedHost(value: unknown): value is PairedHost {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["targetName"] === "string" &&
    typeof record["macName"] === "string" &&
    typeof record["secretHex"] === "string"
  );
}
