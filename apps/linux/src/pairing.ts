// Port of PairingCoordinator.swift plus the terminal PairingUI: "only one pairing in progress
// anywhere on the server", every `begin` matched by exactly one `end`.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PairingUI } from "./seams";

export class PairingCoordinator {
  private inProgress = false;

  constructor(private readonly ui: PairingUI) {}

  get isPairingInProgress(): boolean {
    return this.inProgress;
  }

  /** `false` (and nothing shown) when another pairing is already in progress. */
  begin(deviceName: string, pin: string): boolean {
    if (this.inProgress) return false;
    this.inProgress = true;
    this.ui.beginPairing(deviceName, pin);
    return true;
  }

  /** Idempotent. */
  end(): void {
    if (!this.inProgress) return;
    this.inProgress = false;
    this.ui.endPairing();
  }
}

/** The daemon has no window: the PIN is printed to the terminal it runs in. */
export class TerminalPairingUI implements PairingUI {
  beginPairing(deviceName: string, pin: string): void {
    console.log("");
    console.log(`  Pairing request from "${deviceName}"`);
    console.log(`  Enter this PIN on the phone within 120 s:`);
    console.log("");
    console.log(`      ${pin.slice(0, 3)} ${pin.slice(3)}`);
    console.log("");
  }

  endPairing(): void {
    console.log("  Pairing finished.");
  }
}

/**
 * Shows the PIN as `TerminalPairingUI` does, and also leaves `{pin, expiresAt}` (epoch ms, 0600) in
 * `path` while the pairing is open, so Relay Desktop can display it for a phone that is not on the
 * tailnet (those are the only ones that need a PIN). Removed when the pairing ends.
 */
export class PinFilePairingUI implements PairingUI {
  constructor(
    private readonly inner: PairingUI,
    private readonly path: string,
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  beginPairing(deviceName: string, pin: string): void {
    this.inner.beginPairing(deviceName, pin);
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, JSON.stringify({ pin, expiresAt: this.now() + this.timeoutMs, deviceName }), { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch (error) {
      console.error(`pairing: could not write ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  endPairing(): void {
    rmSync(this.path, { force: true });
    this.inner.endPairing();
  }
}
