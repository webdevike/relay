/**
 * A stream of images (data URIs) shown without flicker or a decode backlog: the newest URI loads
 * into a hidden back image and swaps to the front only once it has decoded. URIs that arrive
 * while one is decoding are not queued; only the latest is loaded next. In dev builds, a running
 * decode time and shown fps are logged every 60 frames (visible in the Metro log).
 */
import { useEffect, useRef, useState } from "react";
import { Image, StyleSheet } from "react-native";
import { info } from "@/connection/log";

export interface LiveImageProps {
  uri: string;
}

export function LiveImage({ uri }: LiveImageProps) {
  const [front, setFront] = useState(uri);
  const [back, setBack] = useState<string | null>(null);
  const latest = useRef(uri);
  const started = useRef(0);
  const stats = useRef({ frames: 0, decodeMs: 0, since: performance.now() });

  useEffect(() => {
    latest.current = uri;
    if (back === null && uri !== front) {
      started.current = performance.now();
      setBack(uri);
    }
  }, [uri, back, front]);

  const loaded = (): void => {
    if (back === null) return;
    if (__DEV__) {
      const s = stats.current;
      s.frames += 1;
      s.decodeMs += performance.now() - started.current;
      if (s.frames === 60) {
        const secs = (performance.now() - s.since) / 1000;
        info("liveview", `shown ${(s.frames / secs).toFixed(1)} fps, decode avg ${(s.decodeMs / s.frames).toFixed(0)} ms`);
        stats.current = { frames: 0, decodeMs: 0, since: performance.now() };
      }
    }
    setFront(back);
    // A newer frame arrived while this one decoded: start it now instead of waiting for the next.
    if (latest.current !== back) {
      started.current = performance.now();
      setBack(latest.current);
    } else {
      setBack(null);
    }
  };

  return (
    <>
      <Image source={{ uri: front }} style={StyleSheet.absoluteFill} resizeMode="contain" fadeDuration={0} />
      {back !== null && (
        <Image source={{ uri: back }} style={[StyleSheet.absoluteFill, styles.hidden]} resizeMode="contain" fadeDuration={0} onLoad={loaded} onError={loaded} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  hidden: { opacity: 0 },
});
