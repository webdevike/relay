/**
 * Pure Bonjour-candidate selection policy. Kept free of any `react-native-zeroconf` import so it
 * is unit-testable in isolation — that package ships pre-built JS that only Metro/Babel can
 * parse, not vitest.
 */
export interface DiscoveredService {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly txt: Record<string, string>;
}

const PROTOCOL_TXT_VERSION = "1";

/** Speaks the current protocol; services without the matching TXT version are never offered. */
export function isCompatible(service: DiscoveredService): boolean {
  return service.txt["v"] === PROTOCOL_TXT_VERSION;
}

/**
 * Picks the service to connect to from every currently resolved service. When the session has a
 * target host, only its Bonjour name counts as a match (another host on the LAN must never hijack
 * the connection; switching is explicit, from the host picker); otherwise the first compatible
 * service is the candidate.
 */
export function pickCandidate(
  services: readonly DiscoveredService[],
  targetBonjourName: string | null,
): DiscoveredService | null {
  const valid = services.filter(isCompatible);
  if (targetBonjourName !== null) {
    return valid.find((service) => service.name === targetBonjourName) ?? null;
  }
  return valid[0] ?? null;
}
