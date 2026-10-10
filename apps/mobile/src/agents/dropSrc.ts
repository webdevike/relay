import { hostBaseUrl } from "@/connection";
import { useConnectionStore } from "@/state/connection";

/** Widget media `src` to a fetchable URL. Drop paths are relative to the connected host, so they
 * resolve to null while disconnected; absolute http(s) URLs pass through. Subscribes to the
 * connection status, so a widget rendered during a reconnect fills in once the phone is back. */
export function useDropSrc(src: string): string | null;
export function useDropSrc(src: readonly string[]): (string | null)[];
export function useDropSrc(src: string | readonly string[]): string | null | (string | null)[] {
  useConnectionStore((s) => s.status);
  const base = hostBaseUrl();
  const one = (s: string) => (!s.startsWith("/drops/") ? s : base === null ? null : `${base}${s}`);
  return typeof src === "string" ? one(src) : src.map(one);
}
