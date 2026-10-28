/**
 * A bundle pinned to one host (`EXPO_PUBLIC_RELAY_ONLY_HOST=<host:port>`, read at bundle time):
 * test builds on a simulator talk to a throwaway host and nothing else. The target is that manual
 * host from boot, Bonjour never runs, and the host picker cannot switch or fall back to another.
 * Unset, every rule here lets the saved choice through. A value that is not `host:port` connects
 * nowhere rather than falling back to discovery. Pure so it is unit-testable without the driver.
 */
import { parseManualHost } from "./manual-host";

export type OnlyHost =
  | { readonly kind: "any" }
  | { readonly kind: "only"; readonly id: string }
  | { readonly kind: "invalid"; readonly raw: string };

export function parseOnlyHost(raw: string | undefined): OnlyHost {
  if (raw === undefined || raw.trim() === "") return { kind: "any" };
  const service = parseManualHost(raw);
  return service === null ? { kind: "invalid", raw } : { kind: "only", id: service.name };
}

/** The target the session may aim at when `requested` is asked for (boot, a switch, a forget). */
export function allowedTarget(only: OnlyHost, requested: string | null): string | null {
  switch (only.kind) {
    case "any":
      return requested;
    case "only":
      return only.id;
    case "invalid":
      return null;
  }
}

/** Whether Bonjour may browse or resolve at all. */
export function mayDiscover(only: OnlyHost): boolean {
  return only.kind === "any";
}
