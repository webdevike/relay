/**
 * What the pairing screen says for a connection state, so it is never a silent wait: a spinner
 * while the host is being found or asked for a code, the PIN prompt once the host shows one, and a
 * plain error (with what to do) when the host never answers. Pure so it is unit-testable.
 */
import type { PairFailure } from "@relay/protocol";
import type { ConnectionStatus, PairingState } from "@/state/connection";

/** How long the screen waits for a host to show a code before saying it found none. */
export const PAIRING_DEADLINE_MS = 15_000;

export interface PairingViewInput {
  readonly status: ConnectionStatus;
  readonly pairing: PairingState;
  readonly lastError: string | null;
  /** The host being paired: its Bonjour name or the typed address. */
  readonly hostName: string | null;
  /** `PAIRING_DEADLINE_MS` has passed since this attempt started. */
  readonly expired: boolean;
}

export interface PairingView {
  readonly message: string;
  /** Show a spinner: something is still in progress. */
  readonly busy: boolean;
  /** Why pairing stopped, null while it is going or waiting for the PIN. */
  readonly error: string | null;
  /** The error is fixed by starting over (a fresh connection), not by retyping the PIN. */
  readonly restart: boolean;
}

const ENTER_PIN = "Enter the 6-digit code shown on your Mac.";

const failureMessage: Record<PairFailure, string> = {
  wrong_pin: "That PIN didn't match. Try again.",
  rejected: "Pairing was declined on your Mac.",
  timeout: "Pairing timed out. Try again.",
  too_many_attempts: "Too many attempts. Wait a moment and try again.",
};

export const NOT_FOUND =
  "No Relay found on your network. Make sure Relay is open on your Mac, or enter the address it shows in Settings > Add by address.";

export function pairingView({ status, pairing, lastError, hostName, expired }: PairingViewInput): PairingView {
  const name = hostName ?? "your Mac";
  if (status === "authenticating" || status === "connected") {
    return { message: "Finishing pairing…", busy: true, error: null, restart: false };
  }
  if (status === "pairing") {
    if (pairing.pinRequired) {
      return {
        message: ENTER_PIN,
        busy: false,
        error: pairing.failure === null ? null : failureMessage[pairing.failure],
        restart: false,
      };
    }
    if (pairing.failure !== null) {
      return { message: `Pairing with ${name} stopped.`, busy: false, error: failureMessage[pairing.failure], restart: false };
    }
    if (expired) {
      return {
        message: `${name} did not show a code.`,
        busy: false,
        error: "Make sure Relay is open on your Mac, then try again.",
        restart: true,
      };
    }
    return { message: `Asking ${name} for a code…`, busy: true, error: null, restart: false };
  }
  if (status === "offline" && lastError !== null) {
    return { message: `Can't pair with ${name}.`, busy: false, error: lastError, restart: true };
  }
  if (expired) {
    return { message: `Can't reach ${name}.`, busy: false, error: NOT_FOUND, restart: true };
  }
  return { message: `Looking for ${name}…`, busy: true, error: null, restart: false };
}
