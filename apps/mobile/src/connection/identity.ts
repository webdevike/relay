/**
 * Device identity and paired-Mac credentials, both backed by expo-secure-store (iOS Keychain).
 * The paired secret is the only credential that ever leaves this module, and only as input to
 * `authProof` (packages/protocol/src/hmac.ts) — never logged, never persisted anywhere else.
 */
import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";

const DEVICE_ID_KEY = "relay.deviceId";
const PAIRED_MAC_KEY = "relay.pairedMac";

export interface PairedMac {
  readonly macName: string;
  readonly secretHex: string;
  readonly bonjourName: string;
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

export async function getPairedMac(): Promise<PairedMac | null> {
  const raw = await SecureStore.getItemAsync(PAIRED_MAC_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isPairedMac(parsed) ? parsed : null;
}

export async function savePairedMac(mac: PairedMac): Promise<void> {
  await SecureStore.setItemAsync(PAIRED_MAC_KEY, JSON.stringify(mac));
}

export async function forgetPairedMac(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRED_MAC_KEY);
}

function isPairedMac(value: unknown): value is PairedMac {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["macName"] === "string" &&
    typeof record["secretHex"] === "string" &&
    typeof record["bonjourName"] === "string"
  );
}
