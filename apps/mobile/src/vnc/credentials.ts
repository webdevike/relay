/**
 * Screen Sharing's login per host, asked once and kept in Keychain (expo-secure-store). It goes
 * only into the live view's web view, which hands it to noVNC for the VNC handshake.
 */
import * as SecureStore from "expo-secure-store";
import { z } from "zod";
import type { VncCredentials } from "./messages";

const Stored = z.object({ username: z.string(), password: z.string().min(1) });

/** SecureStore keys allow only `[A-Za-z0-9._-]`. */
function keyFor(hostId: string): string {
  return `relay.vnc.${hostId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

export async function loadVncCredentials(hostId: string): Promise<VncCredentials | null> {
  const raw = await SecureStore.getItemAsync(keyFor(hostId));
  if (raw === null) return null;
  try {
    const parsed = Stored.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveVncCredentials(hostId: string, credentials: VncCredentials): Promise<void> {
  await SecureStore.setItemAsync(keyFor(hostId), JSON.stringify(credentials));
}

export async function forgetVncCredentials(hostId: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyFor(hostId));
}
