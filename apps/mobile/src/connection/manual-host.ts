/**
 * A user-typed `host:port` that replaces Bonjour discovery. Macs advertise themselves and need
 * none of this; a Linux host on another network segment (or reached over Tailscale, where mDNS
 * does not cross) is entered here. Pure so it is unit-testable without the driver.
 */
import type { DiscoveredService } from "./candidate";

export const MANUAL_HOST_PLACEHOLDER = "100.64.0.1:7817";

/** `host:port`; host is anything without whitespace or a colon, IPv6 must be bracketed. */
const PATTERN = /^\s*(\[[0-9a-f:]+\]|[^\s:[\]]+):(\d{1,5})\s*$/i;

/** `null` when `value` is empty or not a usable `host:port`. */
export function parseManualHost(value: string): DiscoveredService | null {
  const match = PATTERN.exec(value);
  if (match === null) return null;
  const rawHost = match[1] ?? "";
  const port = Number.parseInt(match[2] ?? "", 10);
  if (port < 1 || port > 65535) return null;
  const host = rawHost.startsWith("[") ? rawHost.slice(1, -1) : rawHost;
  return { name: `${host}:${port}`, host, port, txt: { v: "1" } };
}
