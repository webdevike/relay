import { hostBaseUrl } from "@/connection";

/** Widget media `src` to a fetchable URL. Drop paths are relative to the connected host, so they
 * resolve to null while disconnected; absolute http(s) URLs pass through. */
export function resolveDropSrc(src: string): string | null {
  if (!src.startsWith("/drops/")) return src;
  const base = hostBaseUrl();
  return base === null ? null : `${base}${src}`;
}
