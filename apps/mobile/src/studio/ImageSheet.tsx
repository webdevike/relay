/**
 * The create bar's image picker: the library's images (newest first) and the saved Styles and
 * Characters, as a grid of thumbnails. It picks the references of an edit, a video model's
 * references, or one keyframe (`max` 1 replaces the pick and closes). Tapping a picked image again
 * lets it go.
 */
import { useMemo } from "react";
import { Image, Pressable, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { spacing, useColors } from "@/theme";
import { useStudioStore } from "@/state/studio";
import { Button } from "@/ui/Button";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";
import { useHostBase } from "./assets";
import { libraryOf } from "./library";

/** How many library images the picker lists. */
export const PICKER_LIMIT = 60;

export interface PickableImage {
  /** The asset id a spec names. */
  id: string;
  /** Host path of the thumbnail. */
  thumb: string;
  label: string;
  /** A saved Style or Character. */
  saved: boolean;
}

/** Saved references first, then the library's images, newest first. */
export function pickableImages(jobs: Parameters<typeof libraryOf>[0], references: readonly { name: string; asset: { id: string; thumb: string } }[]): PickableImage[] {
  const saved = references.map((r) => ({ id: r.asset.id, thumb: r.asset.thumb, label: r.name, saved: true }));
  const images = libraryOf(jobs)
    .items.filter((item) => item.asset.kind === "image")
    .slice(0, PICKER_LIMIT)
    .map((item) => ({ id: item.asset.id, thumb: item.asset.thumb, label: item.job.spec.prompt, saved: false }));
  return [...saved, ...images];
}

export interface ImageSheetProps {
  visible: boolean;
  title: string;
  selected: readonly string[];
  max: number;
  onChange: (ids: string[]) => void;
  onClose: () => void;
}

export function ImageSheet({ visible, title, selected, max, onChange, onClose }: ImageSheetProps) {
  const colors = useColors();
  const base = useHostBase();
  const jobs = useStudioStore((state) => state.jobs);
  const references = useStudioStore((state) => state.references);
  const images = useMemo(() => pickableImages(jobs, references), [jobs, references]);
  const tile = 72;

  const press = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((s) => s !== id));
    else if (max === 1) {
      onChange([id]);
      onClose();
    } else if (selected.length < max) onChange([...selected, id]);
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ gap: spacing.md, paddingTop: spacing.sm }}>
        <Text variant="title">{title}</Text>
        {images.length === 0 ? (
          <Text variant="body" color="textMuted">
            No images yet. Make one first.
          </Text>
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {images.map((image) => {
              const on = selected.includes(image.id);
              return (
                <Pressable
                  key={image.id}
                  accessibilityRole="imagebutton"
                  accessibilityLabel={image.saved ? `${image.label}, saved reference` : image.label}
                  accessibilityState={{ selected: on }}
                  onPress={() => {
                    press(image.id);
                  }}
                  style={{ width: tile, height: tile, borderRadius: 8, overflow: "hidden", borderWidth: 2, borderColor: on ? colors.accent : "transparent", backgroundColor: colors.surfaceRaised }}
                >
                  {base !== null && <Image source={{ uri: `${base}${image.thumb}` }} resizeMode="cover" style={{ flex: 1 }} />}
                  {image.saved && (
                    <View style={{ position: "absolute", left: 4, bottom: 4 }}>
                      <SymbolView name="bookmark.fill" size={11} tintColor="#FFFFFF" />
                    </View>
                  )}
                  {on && (
                    <View style={{ position: "absolute", right: 4, top: 4 }}>
                      <SymbolView name="checkmark.circle.fill" size={18} tintColor={colors.accent} />
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
        <View style={{ gap: spacing.sm }}>
          {selected.length > 0 && (
            <Button
              label="Clear"
              variant="secondary"
              height={46}
              onPress={() => {
                onChange([]);
                onClose();
              }}
            />
          )}
          <Button label={max === 1 ? "Cancel" : "Done"} variant={selected.length > 0 ? "primary" : "secondary"} height={46} onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}
