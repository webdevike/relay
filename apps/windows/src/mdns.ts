// `_relay._tcp` through Windows' own mDNS responder (dnsapi DnsServiceRegister, Windows 10 1809+),
// so no Bonjour install is needed and there is still exactly one mDNS stack on the PC. TXT matches
// the other hosts (apps/linux/src/mdns.ts): `v=1`, `name=<host>` and `ts=<tailnet IPv4>`; the phone
// connects to `ts` when present, which is the only address this host listens on.

import { FFIType, JSCallback, ptr } from "bun:ffi";
import { hostname } from "node:os";
import { BONJOUR_SERVICE_TYPE } from "@relay/protocol";
import { dnsapi, wide } from "./win32";

const DNS_QUERY_REQUEST_VERSION1 = 1;
const DNS_REQUEST_PENDING = 9506;
/** sizeof(DNS_SERVICE_REGISTER_REQUEST) on x64. */
const REQUEST_SIZE = 48;

export class WindowsBonjourAdvertiser {
  /** Strings and arrays native code points into; held so nothing is collected while registered. */
  private readonly keep: Uint8Array[] = [];
  private request: Uint8Array | null = null;
  private callback: JSCallback | null = null;

  constructor(
    private readonly name: string,
    private readonly port: number,
    private readonly tailnet: string | null,
    private readonly log: (line: string) => void,
  ) {}

  /** Throws when Windows refuses the registration outright; its asynchronous result is logged. */
  start(): void {
    const txt: [string, string][] = [["v", "1"], ["name", this.name]];
    if (this.tailnet !== null) txt.push(["ts", this.tailnet]);
    const dns = dnsapi();
    const keys = new BigUint64Array(txt.length);
    const values = new BigUint64Array(txt.length);
    txt.forEach(([key, value], i) => {
      const k = wide(key);
      const v = wide(value);
      this.keep.push(k, v);
      keys[i] = BigInt(ptr(k));
      values[i] = BigInt(ptr(v));
    });
    const service = wide(`${this.name}.${BONJOUR_SERVICE_TYPE}.local`);
    const host = wide(`${hostname()}.local`);
    this.keep.push(service, host, new Uint8Array(keys.buffer), new Uint8Array(values.buffer));
    const instance = dns.DnsServiceConstructInstance(ptr(service), ptr(host), null, null, this.port, 0, 0, txt.length, ptr(keys), ptr(values));
    if (instance === null) throw new Error("DnsServiceConstructInstance failed");
    // Windows calls back on one of its own threads once the name is probed and announced.
    this.callback = new JSCallback(
      (status: number) => {
        this.log(status === 0 ? `mDNS: ${this.name} registered` : `mDNS: registration of ${this.name} failed (status ${status})`);
      },
      { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.void, threadsafe: true },
    );
    const request = new Uint8Array(REQUEST_SIZE);
    const view = new DataView(request.buffer);
    view.setUint32(0, DNS_QUERY_REQUEST_VERSION1, true);
    view.setUint32(4, 0, true); // every interface
    view.setBigUint64(8, BigInt(instance), true);
    view.setBigUint64(16, BigInt(this.callback.ptr ?? 0), true);
    this.request = request;
    const status = dns.DnsServiceRegister(ptr(request), null);
    if (status !== DNS_REQUEST_PENDING) throw new Error(`DnsServiceRegister returned ${status}`);
  }

  stop(): void {
    if (this.request === null) return;
    dnsapi().DnsServiceDeRegister(ptr(this.request), null);
    this.request = null;
  }
}
