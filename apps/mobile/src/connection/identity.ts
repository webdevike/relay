/**
 * Device identity and paired-host credentials, both backed by expo-secure-store (iOS Keychain).
 * Paired secrets leave this module only inside `PairedHosts`, and the driver passes them on only
 * as input to `authProof` (packages/protocol/src/hmac.ts): never logged, never persisted elsewhere.
 */
import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { fileStorage } from "@/state/storage";
import { migrateLegacyHosts, parsePairedHosts, upsertHost, type PairedHosts } from "./hosts";

const DEVICE_ID_KEY = "relay.deviceId";
const PAIRED_HOSTS_KEY = "relay.hosts";
/** Single paired Mac, before the host list. */
const LEGACY_PAIRED_MAC_KEY = "relay.pairedMac";
/** Per-target array from the quick-connect build. */
const LEGACY_PAIRED_HOSTS_V2_KEY = "relay.pairedHosts.v2";
/** zustand `persist` file of `useSettingsStore`, which held the old single "Host address". */
const SETTINGS_FILE = "relay-settings";
const QUICK_TRUST_FILE = "relay-quick-trust.json";

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
 * Imports trust provisioned through the iOS app-data channel by a physically paired computer and
 * makes it the active host. The plaintext transfer file is deleted after import; the credential
 * then lives only in Keychain.
 */
export async function importProvisionedHost(deviceId: string): Promise<boolean> {
  const file = new File(Paths.document, QUICK_TRUST_FILE);
  if (!file.exists) return false;

  const provision = parseProvisionedHost(await file.text());
  if (provision?.deviceId !== deviceId) {
    file.delete();
    return false;
  }
  const hosts = await loadPairedHosts();
  const { targetName: id, macName: name, secretHex } = provision;
  await savePairedHosts({ ...upsertHost(hosts, { id, name, address: "", secretHex }), activeId: id });
  file.delete();
  return true;
}

function parseProvisionedHost(
  raw: string,
): { deviceId: string; targetName: string; macName: string; secretHex: string } | null {
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

/** The saved list; the first read after upgrading migrates the older formats into it. */
export async function loadPairedHosts(): Promise<PairedHosts> {
  const stored = parsePairedHosts(await SecureStore.getItemAsync(PAIRED_HOSTS_KEY));
  if (stored !== null) return stored;
  const migrated = migrateLegacyHosts(
    await SecureStore.getItemAsync(LEGACY_PAIRED_MAC_KEY),
    await SecureStore.getItemAsync(LEGACY_PAIRED_HOSTS_V2_KEY),
    legacyManualHost(await fileStorage.getItem(SETTINGS_FILE)),
  );
  await savePairedHosts(migrated);
  await SecureStore.deleteItemAsync(LEGACY_PAIRED_MAC_KEY);
  await SecureStore.deleteItemAsync(LEGACY_PAIRED_HOSTS_V2_KEY);
  return migrated;
}

export async function savePairedHosts(hosts: PairedHosts): Promise<void> {
  await SecureStore.setItemAsync(PAIRED_HOSTS_KEY, JSON.stringify(hosts));
}

/** The old "Host address" setting from the persisted settings file, or `""`. */
function legacyManualHost(raw: string | null): string {
  try {
    const value: unknown = (JSON.parse(raw ?? "null") as { state?: { manualHost?: unknown } } | null)?.state?.manualHost;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}
