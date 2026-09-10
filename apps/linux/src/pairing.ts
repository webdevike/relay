// Port of PairingCoordinator.swift plus the terminal PairingUI: "only one pairing in progress
// anywhere on the server", every `begin` matched by exactly one `end`.

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
