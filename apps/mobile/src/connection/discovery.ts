/**
 * Thin wrapper around react-native-zeroconf that scans for the Mac's `_relay._tcp` service and
 * reports the current best candidate. Selection policy lives in `./candidate` (see that file for
 * why it's separate); this file owns only the native scan lifecycle.
 */
import Zeroconf, { type ZeroconfService } from "react-native-zeroconf";
import { pickCandidate, type DiscoveredService } from "./candidate";
import { debug, warn } from "./log";

export { pickCandidate };
export type { DiscoveredService };

const SERVICE_TYPE = "relay"; // react-native-zeroconf builds `_<type>._<protocol>.` -> `_relay._tcp.`
const SERVICE_PROTOCOL = "tcp";
const SERVICE_DOMAIN = "local.";

/** Prefers an IPv4 address from `addresses`; falls back to the mDNS hostname. */
function toDiscoveredService(raw: ZeroconfService): DiscoveredService {
  const ipv4 = raw.addresses?.find((address) => /^\d{1,3}(\.\d{1,3}){3}$/.test(address));
  return { name: raw.name, host: ipv4 ?? raw.host, port: raw.port, txt: raw.txt ?? {} };
}

export interface DiscoveryHandlers {
  readonly onCandidate: (service: DiscoveredService) => void;
}

export class Discovery {
  private readonly zeroconf: Zeroconf;
  private readonly handlers: DiscoveryHandlers;
  private services: DiscoveredService[] = [];
  private pairedBonjourName: string | null = null;
  private scanning = false;

  constructor(handlers: DiscoveryHandlers, zeroconf: Zeroconf = new Zeroconf()) {
    this.handlers = handlers;
    this.zeroconf = zeroconf;
    this.zeroconf.on("resolved", (service) => {
      this.handleResolved(service);
    });
    this.zeroconf.on("remove", (name) => {
      this.services = this.services.filter((service) => service.name !== name);
    });
    this.zeroconf.on("error", (error) => {
      this.handleError(error);
    });
  }

  start(pairedBonjourName: string | null): void {
    this.pairedBonjourName = pairedBonjourName;
    this.services = [];
    this.scanning = true;
    debug("discovery", "scan start", pairedBonjourName ?? "(no preferred mac)");
    this.zeroconf.scan(SERVICE_TYPE, SERVICE_PROTOCOL, SERVICE_DOMAIN);
  }

  /** Idempotent: safe to call whether or not a scan is running. */
  stop(): void {
    if (!this.scanning) return;
    this.scanning = false;
    this.zeroconf.stop();
  }

  private handleResolved(raw: ZeroconfService): void {
    const service = toDiscoveredService(raw);
    this.services = [...this.services.filter((existing) => existing.name !== service.name), service];
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
