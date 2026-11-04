import { describe, expect, it } from "vitest";
import { NOT_FOUND, pairingView, type PairingViewInput } from "./pairingView";

const base: PairingViewInput = {
  status: "discovering",
  pairing: { pinRequired: false, failure: null },
  lastError: null,
  hostName: "Sam's MacBook",
  expired: false,
};

describe("pairingView", () => {
  it("spins while the host is being found, then says none was found", () => {
    for (const status of ["idle", "discovering", "connecting", "reconnecting"] as const) {
      expect(pairingView({ ...base, status })).toEqual({ message: "Looking for Sam's MacBook…", busy: true, error: null, restart: false });
      expect(pairingView({ ...base, status, expired: true })).toEqual({
        message: "Can't reach Sam's MacBook.",
        busy: false,
        error: NOT_FOUND,
        restart: true,
      });
    }
  });

  it("spins while the host is asked for a code, and says so when it never shows one", () => {
    const asking = { ...base, status: "pairing" as const };
    expect(pairingView(asking)).toMatchObject({ message: "Asking Sam's MacBook for a code…", busy: true, error: null });
    const silent = pairingView({ ...asking, expired: true });
    expect(silent).toMatchObject({ busy: false, restart: true });
    expect(silent.error).toContain("Relay is open");
  });

  it("asks for the PIN once the host shows one, even past the deadline", () => {
    const pin = { ...base, status: "pairing" as const, pairing: { pinRequired: true, failure: null }, expired: true };
    expect(pairingView(pin)).toEqual({ message: "Enter the 6-digit code shown on your Mac.", busy: false, error: null, restart: false });
    expect(pairingView({ ...pin, pairing: { pinRequired: true, failure: "wrong_pin" } }).error).toBe("That PIN didn't match. Try again.");
  });

  it("names a pairing failure the host reported", () => {
    const failed = pairingView({ ...base, status: "pairing", pairing: { pinRequired: false, failure: "timeout" }, expired: true });
    expect(failed).toEqual({ message: "Pairing with Sam's MacBook stopped.", busy: false, error: "Pairing timed out. Try again.", restart: false });
  });

  it("shows the host's own error when it refuses the app", () => {
    expect(pairingView({ ...base, status: "offline", lastError: "This Relay needs a newer app." })).toEqual({
      message: "Can't pair with Sam's MacBook.",
      busy: false,
      error: "This Relay needs a newer app.",
      restart: true,
    });
  });

  it("spins while the new credential is checked", () => {
    expect(pairingView({ ...base, status: "authenticating", expired: true })).toMatchObject({ busy: true, error: null });
  });

  it("falls back to 'your Mac' with no host name", () => {
    expect(pairingView({ ...base, hostName: null }).message).toBe("Looking for your Mac…");
  });
});
