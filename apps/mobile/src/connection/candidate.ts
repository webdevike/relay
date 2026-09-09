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

/**
 * Picks the service to connect to from every currently resolved service. When a paired Mac
 * exists, only its remembered `bonjourName` counts as a match (a second Mac on the LAN must
 * never hijack the connection); otherwise the first resolved service is the candidate (v1
 * supports exactly one Mac). Services without the current protocol TXT version are ignored.
 */
export function pickCandidate(
  services: readonly DiscoveredService[],
  pairedBonjourName: string | null,
): DiscoveredService | null {
  const valid = services.filter((service) => service.txt["v"] === PROTOCOL_TXT_VERSION);
  if (pairedBonjourName !== null) {
    return valid.find((service) => service.name === pairedBonjourName) ?? null;
  }
  return valid[0] ?? null;
}
