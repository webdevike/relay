/**
 * Thin wrapper around react-native-zeroconf that scans for hosts' `_relay._tcp` service. One
 * native scan serves two consumers: the session (`start`/`stop`, wants the best candidate) and the
 * host picker (`browse`, wants every compatible service). Selection policy lives in `./candidate`
 * (see that file for why it's separate); this file owns only the native scan lifecycle.
 */
import Zeroconf, { type ZeroconfService } from "react-native-zeroconf";
import { isCompatible, pickCandidate, type DiscoveredService } from "./candidate";
import { debug, warn } from "./log";

export { pickCandidate };
export type { DiscoveredService };

const SERVICE_TYPE = "relay"; // react-native-zeroconf builds `_<type>._<protocol>.` -> `_relay._tcp.`
const SERVICE_PROTOCOL = "tcp";
const SERVICE_DOMAIN = "local.";

/** Prefers the host's advertised Tailscale address (`ts`, no PIN), then IPv4, then the mDNS hostname. */
function toDiscoveredService(raw: ZeroconfService): DiscoveredService {
  const txt = raw.txt ?? {};
  const ipv4 = raw.addresses?.find((address) => /^\d{1,3}(\.\d{1,3}){3}$/.test(address));
  return { name: raw.name, host: txt["ts"] ?? ipv4 ?? raw.host, port: raw.port, txt };
}

export interface DiscoveryHandlers {
  readonly onCandidate: (service: DiscoveredService) => void;
  /** Every compatible service currently resolved, on each change. */
  readonly onServices: (services: DiscoveredService[]) => void;
}

export class Discovery {
  private readonly zeroconf: Zeroconf;
  private readonly handlers: DiscoveryHandlers;
  private services: DiscoveredService[] = [];
  private pairedBonjourName: string | null = null;
  private seeking = false;
  private browsing = false;
  private scanning = false;

  constructor(handlers: DiscoveryHandlers, zeroconf: Zeroconf = new Zeroconf()) {
    this.handlers = handlers;
    this.zeroconf = zeroconf;
    this.zeroconf.on("resolved", (service) => {
      this.handleResolved(service);
    });
    this.zeroconf.on("remove", (name) => {
      this.services = this.services.filter((service) => service.name !== name);
      this.handlers.onServices(this.services.filter(isCompatible));
    });
    this.zeroconf.on("error", (error) => {
      this.handleError(error);
    });
  }

  /** Seeks a candidate; one already resolved by a running browse is reported immediately. */
  start(pairedBonjourName: string | null): void {
    this.pairedBonjourName = pairedBonjourName;
    this.seeking = true;
    debug("discovery", "seek", pairedBonjourName ?? "(no preferred host)");
    if (!this.scanning) {
      this.scan();
      return;
    }
    const candidate = pickCandidate(this.services, pairedBonjourName);
    if (candidate !== null) this.handlers.onCandidate(candidate);
  }

  /** Idempotent: safe to call whether or not a scan is running. Keeps scanning while browsing. */
  stop(): void {
    this.seeking = false;
    if (!this.browsing) this.halt();
  }

  /** Keeps the scan running (and `onServices` firing) while the host picker is on screen. */
  browse(on: boolean): void {
    this.browsing = on;
    if (on && !this.scanning) this.scan();
    if (!on && !this.seeking) this.halt();
  }

  private scan(): void {
    this.services = [];
    this.scanning = true;
    this.handlers.onServices([]);
    this.zeroconf.scan(SERVICE_TYPE, SERVICE_PROTOCOL, SERVICE_DOMAIN);
  }

  private halt(): void {
    if (!this.scanning) return;
    this.scanning = false;
    this.zeroconf.stop();
  }

  private handleResolved(raw: ZeroconfService): void {
    const service = toDiscoveredService(raw);
    this.services = [...this.services.filter((existing) => existing.name !== service.name), service];
    this.handlers.onServices(this.services.filter(isCompatible));
    if (!this.seeking) return;
    const candidate = pickCandidate(this.services, this.pairedBonjourName);
    if (candidate !== null) this.handlers.onCandidate(candidate);
  }

  private handleError(error: Error): void {
    warn("discovery", "zeroconf error", error.message);
    if (!this.scanning) return;
    this.zeroconf.stop();
    this.zeroconf.scan(SERVICE_TYPE, SERVICE_PROTOCOL, SERVICE_DOMAIN);
  }
}
