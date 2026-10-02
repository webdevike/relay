// Advertises `_relay._tcp` through the host's own mDNS responder: `avahi-publish` (Avahi daemon)
// on Linux, `dns-sd -R` (mDNSResponder) on macOS. Going through the system responder (rather than
// a second in-process mDNS responder on :5353) keeps exactly one mDNS stack on the host, which is
// what the phone's resolver and the rest of the LAN expect.
//
// TXT mirrors RelayServer.swift: `v=1` (the phone filters on it) and `name=<host>`.

import { BONJOUR_SERVICE_TYPE } from "@relay/protocol";
import type { Subprocess } from "bun";

const RESTART_DELAY_MS = 2000;

export class BonjourAdvertiser {
  private proc: Subprocess<"ignore", "ignore", "pipe"> | null = null;
  private stopped = false;
  /** argv that registers the service and stays in the foreground until killed. */
  private readonly argv: string[];

  constructor(
    name: string,
    port: number,
    private readonly log: (line: string) => void,
  ) {
    const txt = ["v=1", `name=${name}`];
    this.argv =
      process.platform === "darwin"
        ? ["dns-sd", "-R", name, BONJOUR_SERVICE_TYPE, "local", String(port), ...txt]
        : ["avahi-publish", "-s", name, BONJOUR_SERVICE_TYPE, String(port), ...txt];
  }

  /** The responder tool in use (`dns-sd` or `avahi-publish`). */
  get tool(): string {
    return this.argv[0] ?? "";
  }

  /** Throws when the platform's responder tool is not installed. */
  start(): void {
    if (Bun.which(this.tool) === null) {
      throw new Error(
        this.tool === "dns-sd"
          ? "dns-sd not found (it ships with macOS in /usr/bin)"
          : "avahi-publish not found: install avahi and enable avahi-daemon",
      );
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
    const proc = Bun.spawn(this.argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    this.proc = proc;
    void proc.exited.then(async (code) => {
      if (this.stopped || this.proc !== proc) return;
      const stderr = (await new Response(proc.stderr).text()).trim();
      this.log(`${this.tool} exited ${code}${stderr.length > 0 ? `: ${stderr}` : ""}; retrying in ${RESTART_DELAY_MS} ms`);
      setTimeout(() => {
        if (!this.stopped) this.spawn();
      }, RESTART_DELAY_MS);
    });
  }
}
