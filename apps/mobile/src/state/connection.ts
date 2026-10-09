import { create } from "zustand";
import type { MacState, PairFailure } from "@relay/protocol";
import type { DiscoveredService } from "@/connection/candidate";
import type { SavedHost } from "@/connection/hosts";

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
  /** Paired computers, in the order they were added. */
  hosts: SavedHost[];
  /** Id of the host the session is aimed at; may be an unsaved host while pairing it. */
  activeHostId: string | null;
  /** Compatible Bonjour services, fresh only while a host picker is browsing. */
  discovered: DiscoveredService[];
  set: (partial: Partial<Omit<ConnectionState, "set">>) => void;
}

const initialPairing: PairingState = { pinRequired: false, failure: null };

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "idle",
  mac: null,
  macName: null,
  lastError: null,
  pairing: initialPairing,
  hosts: [],
  activeHostId: null,
  discovered: [],
  set: (partial) => {
    set(partial);
  },
}));
