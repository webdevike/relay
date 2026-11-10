/**
 * Room images (renders and references live on the Mac): `rooms.cmd {op: "image"}` answers a JPEG
 * data URL, kept here per room, path and size in a small LRU so scrolling back never asks again.
 * A request already in flight is shared; a failure is not kept, so the next look asks again.
 */
export const IMAGE_CACHE_LIMIT = 24;

export type ImageFetcher = (roomId: string, path: string, max: number) => Promise<string | null>;

export interface ImageCache {
  /** The data URL if it is cached (and marks it recently used), else undefined. */
  peek(roomId: string, path: string, max: number): string | undefined;
  /** The data URL, from the cache or the host; null when the host could not make it. */
  load(roomId: string, path: string, max: number): Promise<string | null>;
  /** Stores an image the caller already has (the dev preview's fixtures). */
  put(roomId: string, path: string, max: number, uri: string): void;
  clear(): void;
}

const keyOf = (roomId: string, path: string, max: number): string => `${roomId}\n${path}\n${String(max)}`;

export function createImageCache(fetcher: ImageFetcher, limit = IMAGE_CACHE_LIMIT): ImageCache {
  const kept = new Map<string, string>();
  const flying = new Map<string, Promise<string | null>>();
  const touch = (key: string, uri: string): void => {
    kept.delete(key);
    kept.set(key, uri);
    while (kept.size > limit) {
      const oldest = kept.keys().next();
      if (oldest.done === true) break;
      kept.delete(oldest.value);
    }
  };
  return {
    peek(roomId, path, max) {
      const key = keyOf(roomId, path, max);
      const uri = kept.get(key);
      if (uri !== undefined) touch(key, uri);
      return uri;
    },
    load(roomId, path, max) {
      const key = keyOf(roomId, path, max);
      const uri = kept.get(key);
      if (uri !== undefined) {
        touch(key, uri);
        return Promise.resolve(uri);
      }
      const running = flying.get(key);
      if (running !== undefined) return running;
      const request = fetcher(roomId, path, max)
        .catch(() => null)
        .then((found) => {
          flying.delete(key);
          if (found !== null) touch(key, found);
          return found;
        });
      flying.set(key, request);
      return request;
    },
    put(roomId, path, max, uri) {
      touch(keyOf(roomId, path, max), uri);
    },
    clear() {
      kept.clear();
      flying.clear();
    },
  };
}
