/**
 * Markdown images (`![alt](src)`) of one message as a stack of left-aligned tiles, the way a chat
 * app shows pictures: `TILE_WIDTH` wide, shaped by the picture (via `Image.getSize`) between
 * `MIN_HEIGHT` and `MAX_HEIGHT`, cropped to fill (cover), `GAP` apart. A tap opens `ImageViewer`
 * with every loadable image of the stack, starting at the tapped one.
 *
 * `src` is an http(s) URL, or a host drop path from `relay-linux share` (resolved by `useDropSrc`).
 * A path on the Mac can't be fetched, so it shows a muted caption naming the file, not a broken tile.
 */
import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { useColors } from "@/theme";
import { ImageFrame } from "@/ui/ImageFrame";
import { MediaPlaceholder } from "@/ui/MediaPlaceholder";
import { useDropSrc } from "./dropSrc";
import { ImageViewer, type ViewerImage } from "./ImageViewer";
import { type ImageSrcKind, imageBasename, imageSrcKind, type MessageImage } from "./markdown";

const TILE_WIDTH = 188;
const MIN_HEIGHT = 110;
const MAX_HEIGHT = 220;
const RADIUS = 22;
const GAP = 4;

export function MarkdownImages({ images }: { images: MessageImage[] }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const resolved = useDropSrc(images.map((image) => image.src));
  const items = images.map((image, i) => {
    const kind = imageSrcKind(image.src);
    return { ...image, kind, uri: kind === "local" ? null : (resolved[i] ?? null) };
  });

  // The viewer pages through the tiles that have a picture; `pages[i]` is tile i's page (-1: none).
  const loadable: ViewerImage[] = [];
  const pages = items.map((item) =>
    item.uri === null ? -1 : loadable.push({ uri: item.uri, caption: item.alt === "" ? undefined : item.alt }) - 1,
  );

  return (
    <View style={{ gap: GAP, alignItems: "flex-start" }}>
      {items.map((item, i) => (
        <Tile
          key={`${String(i)}:${item.src}`}
          src={item.src}
          alt={item.alt}
          kind={item.kind}
          uri={item.uri}
          onPress={() => {
            setViewing(pages[i] ?? 0);
          }}
        />
      ))}
      <ImageViewer
        images={viewing === null ? null : loadable}
        start={viewing ?? 0}
        onClose={() => {
          setViewing(null);
        }}
      />
    </View>
  );
}

interface TileProps {
  src: string;
  alt: string;
  kind: ImageSrcKind;
  uri: string | null;
  onPress: () => void;
}

function Tile({ src, alt, kind, uri, onPress }: TileProps) {
  const colors = useColors();
  /** width / height once known; `false` when the picture failed to load. */
  const [aspect, setAspect] = useState<number | false | null>(null);

  useEffect(() => {
    setAspect(null);
    if (uri === null) return;
    let live = true;
    Image.getSize(
      uri,
      (w, h) => {
        if (live) setAspect(w > 0 && h > 0 ? w / h : false);
      },
      () => {
        if (live) setAspect(false);
      },
    );
    return () => {
      live = false;
    };
  }, [uri]);

  if (kind === "local") return <MediaPlaceholder label={`Image on the Mac: ${imageBasename(src)}`} />;
  if (uri === null) return <MediaPlaceholder label="Connect to the host to load this image." />;
  if (aspect === false) return <MediaPlaceholder label={alt === "" ? "Image failed to load." : `Image failed to load: ${alt}`} />;
  if (aspect === null) {
    return <View style={{ width: TILE_WIDTH, height: TILE_WIDTH, borderRadius: RADIUS, backgroundColor: colors.surface }} />;
  }
  const height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, TILE_WIDTH / aspect)));
  return (
    <ImageFrame
      uri={uri}
      width={TILE_WIDTH}
      height={height}
      resizeMode="cover"
      radius={RADIUS}
      alt={alt === "" ? undefined : alt}
      onPress={onPress}
    />
  );
}
