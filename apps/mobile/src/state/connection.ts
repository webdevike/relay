import { create } from "zustand";
import type { MacState, PairFailure } from "@relay/protocol";

export type ConnectionStatus =
  | "idle"
  | "discovering"
  | "connecting"
  | "pairing"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "offline";

export interface PairingState {
  pinRequired: boolean;
  failure: PairFailure | null;
}

export interface ConnectionState {
  status: ConnectionStatus;
  mac: MacState | null;
  macName: string | null;
  lastError: string | null;
  pairing: PairingState;
  set: (partial: Partial<Omit<ConnectionState, "set">>) => void;
}

const initialPairing: PairingState = { pinRequired: false, failure: null };

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "idle",
  mac: null,
  macName: null,
  lastError: null,
  pairing: initialPairing,
  set: (partial) => {
    set(partial);
  },
}));
