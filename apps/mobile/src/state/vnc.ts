/**
 * The live view's way in, as the host last answered `vnc.open`: a bridge URL carrying a fresh
 * single-use ticket, or word that Screen Sharing is off on the Mac. Not persisted.
 */
import { create } from "zustand";

export type VncAccessState =
  | { readonly kind: "idle" }
  | { readonly kind: "asking" }
  /** Open `url` once; any later connection needs a new ticket. */
  | { readonly kind: "ready"; readonly url: string }
  /** Nothing listens on the Mac's VNC port: Screen Sharing is off. */
  | { readonly kind: "off" };

export interface VncStore {
  access: VncAccessState;
  setAccess: (access: VncAccessState) => void;
}

export const useVncStore = create<VncStore>((set) => ({
  access: { kind: "idle" },
  setAccess: (access) => {
    set({ access });
  },
}));
