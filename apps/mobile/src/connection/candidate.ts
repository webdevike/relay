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
 * Picks the first valid preferred host. If none of the remembered hosts are present, returns the
 * first valid service so a newly encountered computer can enter the normal authenticated pairing
 * flow.
 */
export function pickCandidate(
  services: readonly DiscoveredService[],
  pairedTargetNames: readonly string[],
): DiscoveredService | null {
  const valid = services.filter((service) => service.txt["v"] === PROTOCOL_TXT_VERSION);
  for (const targetName of pairedTargetNames) {
    const preferred = valid.find((service) => service.name === targetName);
    if (preferred !== undefined) return preferred;
  }
  return valid[0] ?? null;
}
