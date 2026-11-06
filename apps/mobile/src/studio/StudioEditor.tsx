/**
 * One image full screen on dark chrome, with its versions: swipe left and right (or tap the strip)
 * through `studioVersions` of its original, pinch to zoom. Favorite, Save, Move and Delete (with
 * Undo) act on the version on screen, and "Describe your edit" makes a new version of it with the
 * chosen engine (`editRecipe`). While a child of the version on screen is queued or running, the
 * image blurs under a dot matrix and says how far along it is; the strip ends in a spinner, and the
 * edit started here is selected when it lands.
 */
import { useEffect, useMemo, useState } from "react";
import { Image, Keyboard, KeyboardAvoidingView, Modal, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useVideoPlayer, VideoView } from "expo-video";
import { studioJobActive, studioRootOf, studioVersions, type StudioItem, type StudioJob } from "@relay/protocol";
import { studioRequest } from "@/connection";
import { useStudioStore } from "@/state/studio";
import { spacing } from "@/theme";
import { ZoomableImage } from "@/agents/ZoomableImage";
import { Chip } from "@/ui/Chip";
import { DotMatrix } from "@/ui/DotMatrix";
import { IconButton } from "@/ui/IconButton";
import { MenuButton } from "@/ui/MenuButton";
import { Pager } from "@/ui/Pager";
import { Text } from "@/ui/Text";
import { ThumbStrip } from "@/ui/ThumbStrip";
import { ToolbarButton } from "@/ui/ToolbarButton";
import { favoriteAssets, moveAssets, toast, trashAssets } from "./actions";
import { saveAssets, useHostBase } from "./assets";
import { libraryOf } from "./library";
import { chooseFrom, pickProject } from "./pickers";
import { defaultEngine, EDIT_ENGINES, EDIT_SUGGESTIONS, editRecipe, engineProblem, type EditEngineId } from "./recipes";
import { ToastHost } from "./ToastHost";

const BG = "#0C0C0D";
const BAR = "#1A1B1E";
const BAR_EDGE = "#2C2E33";

export interface StudioEditorProps {
  /** The image opened; null keeps the editor closed. */
  assetId: string | null;
  onClose: () => void;
}

export function StudioEditor({ assetId, onClose }: StudioEditorProps) {
  return (
    <Modal visible={assetId !== null} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* A Modal renders outside the app root's gesture provider; pinch and pan need their own. */}
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: BG }}>{assetId !== null && <Editor initial={assetId} onClose={onClose} />}</GestureHandlerRootView>
    </Modal>
  );
}

/** The image's box inside `box` at its aspect (contain). */
function fitRect(box: { width: number; height: number }, width: number, height: number) {
  const scale = Math.min(box.width / width, box.height / height);
  const w = width * scale;
  const h = height * scale;
  return { left: (box.width - w) / 2, top: (box.height - h) / 2, width: w, height: h };
}

function generatingLabel(job: StudioJob): string {
  return job.state === "running" ? `Generating ${Math.min(99, Math.round(job.progress * 100))}%` : "Waiting in the GPU queue";
}

function Editor({ initial, onClose }: { initial: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const base = useHostBase();
  const jobs = useStudioStore((state) => state.jobs);
  const backends = useStudioStore((state) => state.backends);
  const projects = useStudioStore((state) => state.projects);
  const library = useMemo(() => libraryOf(jobs), [jobs]);
  const [current, setCurrent] = useState(initial);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [zoomed, setZoomed] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [engine, setEngine] = useState<EditEngineId>(() => defaultEngine(backends));
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  /** The job this editor started, selected when it lands. */
  const [following, setFollowing] = useState<string | null>(null);

  const root = studioRootOf(current, library.lineage);
  const versions = useMemo(() => (root === undefined ? [] : studioVersions(root.asset.id, library.lineage)), [root, library]);
  const index = versions.findIndex((v) => v.asset.id === current);
  const item: StudioItem | undefined = versions[index];
  const family = new Set(versions.map((v) => v.asset.id));
  const children = jobs.filter((job) => studioJobActive(job) && job.parent !== undefined && family.has(job.parent.asset));
  const working = children.find((job) => job.parent?.asset === current);

  // Gone from under the editor (trashed or deleted elsewhere): back to the grid.
  useEffect(() => {
    if (item === undefined) onClose();
  }, [item, onClose]);

  useEffect(() => {
    if (following === null) return;
    const job = jobs.find((j) => j.id === following);
    if (job === undefined || studioJobActive(job)) return;
    setFollowing(null);
    const made = job.outputs.find((o) => o.deletedAt === undefined);
    if (job.state === "done" && made !== undefined) setCurrent(made.id);
    else if (job.state === "failed") toast(job.error ?? "The edit failed");
  }, [jobs, following]);

  if (item === undefined) return null;
  const engineOf = EDIT_ENGINES.find((e) => e.id === engine) ?? EDIT_ENGINES[0];
  const isImage = item.asset.kind === "image";

  const send = async () => {
    const recipe = editRecipe(engine, item, prompt, backends);
    if (!recipe.ok) {
      toast(recipe.error);
      return;
    }
    setSending(true);
    const result = await studioRequest(recipe.op);
    setSending(false);
    if (!result.ok) {
      toast(result.error ?? "Your Mac did not start the edit.");
      return;
    }
    setFollowing(result.job?.id ?? result.jobs?.[0]?.id ?? null);
    setPrompt("");
    Keyboard.dismiss();
  };

  const remove = () => {
    const next = versions[index + 1] ?? versions[index - 1];
    if (next === undefined) onClose();
    else setCurrent(next.asset.id);
    void trashAssets([item.asset.id]);
  };

  const rect = box.width > 0 ? fitRect(box, item.asset.width, item.asset.height) : undefined;

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom + spacing.sm }}>
      <View style={styles.top}>
        <IconButton symbol="chevron.left" tone="overlay" size={40} accessibilityLabel="Back to grid" onPress={onClose} />
        <Text variant="label" numberOfLines={1} style={styles.title}>
          {index === 0 ? "Original" : `Version ${index + 1} of ${versions.length}`}
        </Text>
        <View style={{ width: 40 }} />
      </View>

      <View
        style={styles.canvas}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setBox({ width, height });
        }}
      >
        {box.width > 0 && (
          <Pager
            width={box.width}
            page={index}
            scrollEnabled={!zoomed && versions.length > 1}
            onPageChange={(page) => {
              const to = versions[page];
              if (to !== undefined) setCurrent(to.asset.id);
              setZoomed(false);
            }}
          >
            {versions.map((v, i) => {
              const uri = base === null ? null : `${base}${v.asset.path}`;
              return (
                <View key={v.asset.id} style={{ width: box.width, height: box.height }}>
                  {uri !== null &&
                    (v.asset.kind === "video" ? (
                      i === index ? (
                        <EditorVideo uri={uri} />
                      ) : (
                        <Image source={{ uri: `${base}${v.asset.thumb}` }} resizeMode="contain" style={StyleSheet.absoluteFill} />
                      )
                    ) : (
                      <ZoomableImage
                        // Pages away from the current one come back at fit.
                        key={`${v.asset.id}-${i === index}`}
                        uri={uri}
                        width={box.width}
                        height={box.height}
                        onTap={Keyboard.dismiss}
                        onZoomChange={setZoomed}
                      />
                    ))}
                </View>
              );
            })}
          </Pager>
        )}
        {working !== undefined && rect !== undefined && (
          <View pointerEvents="none" style={[styles.generating, rect]}>
            {base !== null && <Image source={{ uri: `${base}${item.asset.thumb}` }} blurRadius={26} resizeMode="cover" style={StyleSheet.absoluteFill} />}
            <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.2)" }]} />
            <DotMatrix width={rect.width} height={rect.height} />
            <View style={styles.pill}>
              <Text variant="label" tabular style={{ color: "#FFFFFF" }}>
                {generatingLabel(working)}
              </Text>
            </View>
          </View>
        )}
        <ToastHost bottom={spacing.lg} />
      </View>

      <View style={styles.strip}>
        <ThumbStrip
          items={versions.map((v, i) => ({ key: v.asset.id, uri: base === null ? null : `${base}${v.asset.thumb}`, video: v.asset.kind === "video", accessibilityLabel: i === 0 ? "Original" : `Version ${i + 1}` }))}
          selected={current}
          pending={children.length > 0}
          onSelect={setCurrent}
        />
      </View>

      <View style={styles.actions}>
        <ToolbarButton
          symbol={item.asset.favorite === true ? "heart.fill" : "heart"}
          label={item.asset.favorite === true ? "Favorited" : "Favorite"}
          tone="overlay"
          onPress={() => {
            void favoriteAssets([item.asset.id], item.asset.favorite !== true);
          }}
        />
        <ToolbarButton
          symbol="square.and.arrow.down"
          label="Save"
          tone="overlay"
          onPress={() => {
            void saveAssets([item.asset]);
          }}
        />
        <ToolbarButton
          symbol="folder"
          label="Move"
          tone="overlay"
          onPress={() => {
            void pickProject("Move to", projects).then((choice) => {
              if (choice?.kind === "project") void moveAssets([item.asset.id], choice.id);
            });
          }}
        />
        <ToolbarButton symbol="trash" label="Delete" tone="overlay" onPress={remove} />
      </View>

      {isImage && (
        <View style={styles.bottom}>
          {prompt.length === 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.suggestions}>
              {EDIT_SUGGESTIONS.map((suggestion) => (
                <Chip
                  key={suggestion}
                  label={suggestion}
                  overlay
                  hitSlop={{ top: 8, bottom: 8 }}
                  onPress={() => {
                    setPrompt(suggestion);
                  }}
                />
              ))}
            </ScrollView>
          )}
          <View style={[styles.bar, focused && { borderColor: "#4DABF7" }]}>
            <MenuButton
              label={engineOf?.label ?? "Engine"}
              overlay
              accessibilityLabel="Edit engine"
              onPress={() => {
                void chooseFrom(
                  "Edit with",
                  EDIT_ENGINES.map((e) => `${e.label}, ${engineProblem(e, backends) === undefined ? e.where : "not available"}`),
                ).then((picked) => {
                  const next = picked === null ? undefined : EDIT_ENGINES[picked];
                  if (next === undefined) return;
                  const problem = engineProblem(next, backends);
                  if (problem === undefined) setEngine(next.id);
                  else toast(problem);
                });
              }}
            />
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              placeholder="Describe your edit"
              placeholderTextColor="rgba(233,236,239,0.6)"
              keyboardAppearance="dark"
              selectionColor="#4DABF7"
              returnKeyType="send"
              onSubmitEditing={() => {
                void send();
              }}
              onFocus={() => {
                setFocused(true);
              }}
              onBlur={() => {
                setFocused(false);
              }}
              accessibilityLabel="Describe your edit"
              style={styles.input}
            />
            <IconButton
              symbol="arrow.up"
              size={34}
              backgroundColor="#228BE6"
              tintColor="#FFFFFF"
              disabled={sending || prompt.trim().length === 0}
              accessibilityLabel="Send edit"
              onPress={() => {
                void send();
              }}
            />
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function EditorVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer({ uri }, (p) => {
    p.loop = true;
    p.play();
  });
  return <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls contentFit="contain" />;
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  title: { flex: 1, textAlign: "center", color: "#E9ECEF" },
  canvas: { flex: 1, overflow: "hidden" },
  // Square like the image under it, so no corner of the sharp image shows past the blur.
  generating: { position: "absolute", overflow: "hidden", alignItems: "center", justifyContent: "center" },
  pill: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 999, backgroundColor: "rgba(20,20,22,0.8)" },
  strip: { paddingTop: spacing.md },
  actions: { flexDirection: "row", justifyContent: "space-around", paddingHorizontal: spacing.sm, paddingTop: spacing.md },
  bottom: { gap: spacing.sm, paddingTop: spacing.md },
  suggestions: { gap: spacing.sm, paddingHorizontal: spacing.lg },
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginHorizontal: spacing.lg, paddingLeft: spacing.xs, paddingRight: 6, minHeight: 48, borderRadius: 24, backgroundColor: BAR, borderWidth: 1, borderColor: BAR_EDGE },
  input: { flex: 1, color: "#E9ECEF", fontSize: 15, paddingVertical: spacing.sm },
});
