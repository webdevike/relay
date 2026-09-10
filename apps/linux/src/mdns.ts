// Advertises `_relay._tcp` through the running Avahi daemon via `avahi-publish`. Going through
// Avahi (rather than a second in-process mDNS responder on :5353) keeps exactly one mDNS stack
// on the host, which is what the phone's resolver and the rest of the LAN expect.
//
// TXT mirrors RelayServer.swift: `v=1` (the phone filters on it) and `name=<host>`.

import { BONJOUR_SERVICE_TYPE } from "@relay/protocol";
import type { Subprocess } from "bun";

const RESTART_DELAY_MS = 2000;

export class AvahiAdvertiser {
  private proc: Subprocess<"ignore", "ignore", "pipe"> | null = null;
  private stopped = false;

  constructor(
    private readonly name: string,
    private readonly port: number,
    private readonly log: (line: string) => void,
  ) {}

  /** Throws when `avahi-publish` is not installed. */
  start(): void {
    if (Bun.which("avahi-publish") === null) {
      throw new Error("avahi-publish not found: install avahi and enable avahi-daemon");
    }
    this.stopped = false;
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
  }

  private spawn(): void {
    const proc = Bun.spawn(
      ["avahi-publish", "-s", this.name, BONJOUR_SERVICE_TYPE, String(this.port), "v=1", `name=${this.name}`],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    this.proc = proc;
    void proc.exited.then(async (code) => {
      if (this.stopped || this.proc !== proc) return;
      const stderr = (await new Response(proc.stderr).text()).trim();
      this.log(`avahi-publish exited ${code}${stderr.length > 0 ? `: ${stderr}` : ""}; retrying in ${RESTART_DELAY_MS} ms`);
      setTimeout(() => {
        if (!this.stopped) this.spawn();
      }, RESTART_DELAY_MS);
    });
  }
}
