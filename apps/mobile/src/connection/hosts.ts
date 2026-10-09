/**
 * The phone's list of paired computers and which one it connects to. Pure (no Keychain, no React
 * Native) so the list operations and the one-time migration from the single-Mac format are
 * unit-testable; `./identity` owns the storage.
 *
 * A host's `id` is what the session connects to: a typed `host:port` (anything `parseManualHost`
 * accepts, used as-is), otherwise a Bonjour service name re-resolved on every connection.
 */
import { parseManualHost } from "./manual-host";

export interface PairedHost {
  readonly id: string;
  /** The host's own name from its last `welcome`, or the service name until the first one. */
  readonly name: string;
  /** `host:port` last connected to, for display; empty until the first connection. */
  readonly address: string;
  readonly secretHex: string;
}

/** A paired host as screens see it: the secret never leaves the connection module. */
export type SavedHost = Omit<PairedHost, "secretHex">;

export interface PairedHosts {
  /** The host connected to on launch; `null` only when `hosts` is empty. */
  readonly activeId: string | null;
  readonly hosts: readonly PairedHost[];
}

export const NO_HOSTS: PairedHosts = { activeId: null, hosts: [] };

/** Replaces the host with the same id in place, or appends it. Never changes `activeId`. */
export function upsertHost(state: PairedHosts, host: PairedHost): PairedHosts {
  const index = state.hosts.findIndex((existing) => existing.id === host.id);
  const hosts = index === -1 ? [...state.hosts, host] : state.hosts.map((existing, i) => (i === index ? host : existing));
  return { ...state, hosts };
}

/** Drops `id`; forgetting the active host makes the first remaining one active. */
export function removeHost(state: PairedHosts, id: string): PairedHosts {
  const hosts = state.hosts.filter((host) => host.id !== id);
  return { hosts, activeId: state.activeId === id ? (hosts[0]?.id ?? null) : state.activeId };
}

/** `null` when absent or unreadable, so the caller falls back to migrating the legacy keys. */
export function parsePairedHosts(raw: string | null): PairedHosts | null {
  const record = asRecord(parseJson(raw));
  const activeId = record?.["activeId"];
  const hosts = record?.["hosts"];
  if (!(typeof activeId === "string" || activeId === null) || !Array.isArray(hosts) || !hosts.every(isPairedHost)) return null;
  return { activeId, hosts };
}

/**
 * Builds the list from the formats it replaces: the single-Mac `relay.pairedMac` entry and the
 * per-target `relay.pairedHosts.v2` array an earlier quick-connect build wrote. The single entry
 * authenticated against whatever the old "Host address" setting (`legacyManualHost`) pointed at,
 * so that address, when set, is its id. It ends up active because builds since wrote only it.
 */
export function migrateLegacyHosts(pairedMacRaw: string | null, pairedHostsV2Raw: string | null, legacyManualHost: string): PairedHosts {
  let state = NO_HOSTS;
  const v2 = parseJson(pairedHostsV2Raw);
  for (const entry of Array.isArray(v2) ? v2 : []) {
    const record = asRecord(entry);
    const id = record?.["targetName"];
    const name = record?.["macName"];
    const secretHex = record?.["secretHex"];
    if (typeof id !== "string" || id === "" || typeof name !== "string" || typeof secretHex !== "string") continue;
    state = { ...upsertHost(state, { id, name, address: "", secretHex }), activeId: id };
  }
  const single = asRecord(parseJson(pairedMacRaw));
  const name = single?.["macName"];
  const secretHex = single?.["secretHex"];
  const bonjourName = single?.["bonjourName"];
  if (typeof name === "string" && typeof secretHex === "string" && typeof bonjourName === "string") {
    const id = parseManualHost(legacyManualHost) === null ? bonjourName : legacyManualHost.trim();
    if (id !== "") state = { ...upsertHost(state, { id, name, address: "", secretHex }), activeId: id };
  }
  return state;
}

function isPairedHost(value: unknown): value is PairedHost {
  const record = asRecord(value);
  return (
    record !== null &&
    typeof record["id"] === "string" &&
    typeof record["name"] === "string" &&
    typeof record["address"] === "string" &&
    typeof record["secretHex"] === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
