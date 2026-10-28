/**
 * The hosts a live call may reach, preferred first, as the native engine stores them for calls
 * started with no JS (Action Button, lock screen). Pure, so the order is unit-tested: the
 * authority the app is connected through right now, then the active host's other known address
 * (a typed `host:port`), then every other paired host by its last address or typed id.
 */
import { WS_PATH } from "@relay/protocol";
import type { PairedHost } from "@/connection/hosts";
import { parseManualHost } from "@/connection/manual-host";

/** Same shape as `LiveCallHost` in modules/live-call (kept free of native imports for tests). */
export interface LiveHostEntry {
  url: string;
  deviceId: string;
  deviceName: string;
  secretHex: string;
  name: string;
}

export interface LiveHostsInput {
  /** `host:port` of the socket that just authenticated (IPv6 bracketed), if any. */
  authority: string | null;
  /** The saved host that authority belongs to. */
  activeId: string | null;
  hosts: readonly PairedHost[];
  deviceId: string;
  deviceName: string;
}

export function liveCallHosts({ authority, activeId, hosts, deviceId, deviceName }: LiveHostsInput): LiveHostEntry[] {
  const out: LiveHostEntry[] = [];
  const add = (address: string | null, host: PairedHost): void => {
    if (address === null || address === "" || host.secretHex === "") return;
    const url = `ws://${address}${WS_PATH}`;
    if (out.some((entry) => entry.url === url)) return;
    out.push({ url, deviceId, deviceName: deviceName.trim() === "" ? "iPhone" : deviceName, secretHex: host.secretHex, name: host.name });
  };
  const active = hosts.find((host) => host.id === activeId);
  const ordered = active === undefined ? hosts : [active, ...hosts.filter((host) => host !== active)];
  if (active !== undefined) add(authority, active);
  for (const host of ordered) {
    add(host.address, host);
    add(manualAuthority(host.id), host);
  }
  return out;
}

/** A typed `host:port` id as an authority; null for a Bonjour service name. */
function manualAuthority(id: string): string | null {
  const manual = parseManualHost(id);
  if (manual === null) return null;
  return `${manual.host.includes(":") ? `[${manual.host}]` : manual.host}:${String(manual.port)}`;
}
