/**
 * One image full screen on dark chrome, with its versions: swipe left and right (or tap the strip)
 * through `studioVersions` of its original, pinch to zoom. Favorite, Save, Move and Delete (with
 * Undo) act on the version on screen, and "Describe your edit" makes a new version of it with the
 * chosen engine (`editRecipe`). While a child of the version on screen is queued or running, the
 * image blurs under a dot matrix and says how far along it is; the strip ends in a spinner, and the
 * edit started here is selected when it lands.
 */
import { useEffect, useMemo, useState } from "react";
import { Image, Keyboard, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
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
import { cancelJob, favoriteAssets, moveAssets, toast, trashAssets } from "./actions";
import { saveAssets, useHostBase } from "./assets";
import { libraryOf } from "./library";
import { chooseFrom, pickProject } from "./pickers";
import { createEntries, EMPTY_CREATE, videoSettings } from "./create";
import { defaultEngine, EDIT_ENGINES, EDIT_SUGGESTIONS, editRecipe, engineProblem, presetRecipe, toolPresets, videoRecipe, type EditEngineId, type EditRecipe } from "./recipes";
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

const pendingKey = (job: StudioJob): string => `job:${job.id}`;

/** A pending version's slot: its source blurred under a dot matrix, with how far along it is. */
function GeneratingView({ uri, rect, label, onCancel }: { uri: string; rect: { left: number; top: number; width: number; height: number }; label: string; onCancel: () => void }) {
  return (
    <View style={[styles.generating, rect]}>
      <Image source={{ uri }} blurRadius={26} resizeMode="cover" style={StyleSheet.absoluteFill} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.2)" }]} />
      <DotMatrix width={rect.width} height={rect.height} />
      <View style={styles.pill}>
        <Text variant="label" tabular style={{ color: "#FFFFFF" }}>
          {label}
        </Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Cancel generation" onPress={onCancel} style={styles.cancel}>
        <Text variant="label" style={{ color: "#FFFFFF" }}>
          Cancel
        </Text>
      </Pressable>
    </View>
  );
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
  /** The pending job whose slot is on screen; null shows a version. */
  const [viewing, setViewing] = useState<string | null>(null);

  const root = studioRootOf(current, library.lineage);
  const versions = useMemo(() => (root === undefined ? [] : studioVersions(root.asset.id, library.lineage)), [root, library]);
  const index = versions.findIndex((v) => v.asset.id === current);
  const item: StudioItem | undefined = versions[index];
  const family = new Set(versions.map((v) => v.asset.id));
  const children = jobs.filter((job) => studioJobActive(job) && job.parent !== undefined && family.has(job.parent.asset)).sort((a, b) => a.createdAt - b.createdAt);

  // Gone from under the editor (trashed or deleted elsewhere): back to the grid.
  useEffect(() => {
    if (item === undefined) onClose();
  }, [item, onClose]);

  // A pending slot whose job finished or went away: back to the versions.
  useEffect(() => {
    if (viewing !== null && !children.some((job) => job.id === viewing)) setViewing(null);
  }, [viewing, children]);

  // The edit this editor started lands in the strip; it is selected only if Isaac is watching its slot,
  // so previewing an earlier version while it generates is never interrupted.
  useEffect(() => {
    if (following === null) return;
    const job = jobs.find((j) => j.id === following);
    if (job === undefined || studioJobActive(job)) return;
    setFollowing(null);
    const made = job.outputs.find((o) => o.deletedAt === undefined);
    if (job.state === "done" && made !== undefined) {
      if (viewing === job.id) setCurrent(made.id);
    } else if (job.state === "failed") toast(job.error ?? "The edit failed");
  }, [jobs, following, viewing]);

  const pendingJob = viewing === null ? undefined : children.find((job) => job.id === viewing);
  const pendingIndex = pendingJob === undefined ? -1 : children.indexOf(pendingJob);
  const page = pendingIndex >= 0 ? versions.length + pendingIndex : index;
  const parentOf = (job: StudioJob): StudioItem | undefined => (job.parent === undefined ? undefined : versions.find((v) => v.asset.id === job.parent?.asset));
  /** Picks a version, or a pending slot (`job:<id>`); either way the zoom resets. */
  const selectKey = (key: string) => {
    setZoomed(false);
    if (key.startsWith("job:")) setViewing(key.slice(4));
    else {
      setViewing(null);
      setCurrent(key);
    }
  };

  if (item === undefined) return null;
  const engineOf = EDIT_ENGINES.find((e) => e.id === engine) ?? EDIT_ENGINES[0];
  const isImage = item.asset.kind === "image";

  const submit = async (recipe: EditRecipe) => {
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
    const started = result.job?.id ?? result.jobs?.[0]?.id ?? null;
    setFollowing(started);
    // Its progress is its own slot after the versions, shown at once; the versions stay one tap away.
    if (started !== null) {
      setViewing(started);
      setZoomed(false);
    }
    setPrompt("");
    Keyboard.dismiss();
  };

  const send = () => submit(editRecipe(engine, item, prompt, backends));

  /** A ComfyUI preset the host lists for one picture (relight, angle, upscale, ...): its choices are asked one by one. */
  const runTool = async () => {
    const presets = toolPresets(backends);
    if (presets.length === 0) {
      toast(backends.find((b) => b.id === "comfyui")?.reason ?? "This host lists no ComfyUI tools");
      return;
    }
    const picked = await chooseFrom(
      "Tools",
      presets.map((m) => (m.description === undefined ? m.name : `${m.name}, ${m.description}`)),
    );
    const model = picked === null ? undefined : presets[picked];
    if (model === undefined) return;
    const params: Record<string, string | number> = {};
    for (const input of model.inputs ?? []) {
      if (input.kind === "number") {
        params[input.id] = input.default;
        continue;
      }
      const option = await chooseFrom(
        input.label,
        input.options.map((o) => (o.id === input.default ? `${o.label} (default)` : o.label)),
      );
      if (option === null) return;
      params[input.id] = input.options[option]?.id ?? input.default;
    }
    await submit(presetRecipe(model, item, prompt, params, backends));
  };

  /** A video from this version: any free video model the host lists, a length, and an end frame where the model takes one. */
  const makeVideo = async () => {
    const models = createEntries(backends, "video").filter((e) => !e.paid);
    if (models.length === 0) {
      toast("This host has no free video model");
      return;
    }
    const picked = await chooseFrom(
      "Make a video with",
      models.map((e) => `${e.label}, ${e.available ? "local" : "not available"}`),
    );
    const entry = picked === null ? undefined : models[picked];
    if (entry === undefined) return;
    if (!entry.available) {
      toast(entry.reason ?? `${entry.label} is unavailable`);
      return;
    }
    const settings = videoSettings({ ...EMPTY_CREATE, mode: "video" }, entry, backends);
    let seconds = settings?.length;
    if (settings !== undefined && settings.seconds.length > 1) {
      const length = await chooseFrom(
        "Length",
        settings.seconds.map((s) => `${s} seconds`),
      );
      if (length === null) return;
      seconds = settings.seconds[length];
    }
    let end: string | undefined;
    const others = versions.filter((v) => v.asset.id !== item.asset.id && v.asset.kind === "image");
    if (settings?.frames.includes("end") === true && others.length > 0) {
      const frame = await chooseFrom("End frame", ["No end frame", ...others.map((v) => (versions.indexOf(v) === 0 ? "Original" : `Version ${versions.indexOf(v) + 1}`))]);
      if (frame === null) return;
      end = others[frame - 1]?.asset.id;
    }
    await submit(videoRecipe(entry, item, prompt, backends, { seconds, end }));
  };

  const remove = () => {
    const next = versions[index + 1] ?? versions[index - 1];
    if (next === undefined) onClose();
    else setCurrent(next.asset.id);
    void trashAssets([item.asset.id]);
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom + spacing.sm }}>
      <View style={styles.top}>
        <IconButton symbol="chevron.left" tone="overlay" size={40} accessibilityLabel="Back to grid" onPress={onClose} />
        <Text variant="label" numberOfLines={1} style={styles.title}>
          {pendingJob !== undefined ? "New version" : index === 0 ? "Original" : `Version ${index + 1} of ${versions.length}`}
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
            page={page}
            scrollEnabled={!zoomed && versions.length + children.length > 1}
            onPageChange={(next) => {
              const to = versions[next];
              if (to !== undefined) selectKey(to.asset.id);
              else {
                const job = children[next - versions.length];
                if (job !== undefined) selectKey(pendingKey(job));
              }
            }}
          >
            {[
              ...versions.map((v, i) => {
                const uri = base === null ? null : `${base}${v.asset.path}`;
                return (
                  <View key={v.asset.id} style={{ width: box.width, height: box.height }}>
                    {uri !== null &&
                      (v.asset.kind === "video" ? (
                        i === page ? (
                          <EditorVideo uri={uri} />
                        ) : (
                          <Image source={{ uri: `${base}${v.asset.thumb}` }} resizeMode="contain" style={StyleSheet.absoluteFill} />
                        )
                      ) : (
                        <ZoomableImage
                          // Pages away from the current one come back at fit.
                          key={`${v.asset.id}-${i === page}`}
                          uri={uri}
                          width={box.width}
                          height={box.height}
                          onTap={Keyboard.dismiss}
                          onZoomChange={setZoomed}
                        />
                      ))}
                  </View>
                );
              }),
              ...children.map((job) => {
                const from = parentOf(job);
                return (
                  <View key={`pending-${job.id}`} style={{ width: box.width, height: box.height }}>
                    {from !== undefined && base !== null && <GeneratingView uri={`${base}${from.asset.thumb}`} rect={fitRect(box, from.asset.width, from.asset.height)} label={generatingLabel(job)} onCancel={() => void cancelJob(job.id)} />}
                  </View>
                );
              }),
            ]}
          </Pager>
        )}
        <ToastHost bottom={spacing.lg} />
      </View>

      <View style={styles.strip}>
        <ThumbStrip
          items={[
            ...versions.map((v, i) => ({ key: v.asset.id, uri: base === null ? null : `${base}${v.asset.thumb}`, video: v.asset.kind === "video", accessibilityLabel: i === 0 ? "Original" : `Version ${i + 1}` })),
            ...children.map((job) => ({ key: pendingKey(job), uri: base === null ? null : `${base}${parentOf(job)?.asset.thumb ?? ""}`, busy: true, accessibilityLabel: `Generating, ${generatingLabel(job)}` })),
          ]}
          selected={pendingJob === undefined ? current : pendingKey(pendingJob)}
          onSelect={selectKey}
        />
      </View>

      {pendingJob === undefined && (
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
        {isImage && (
          <ToolbarButton
            symbol="wand.and.stars"
            label="Tools"
            tone="overlay"
            disabled={sending}
            onPress={() => {
              void runTool();
            }}
          />
        )}
        {isImage && (
          <ToolbarButton
            symbol="video"
            label="Video"
            tone="overlay"
            disabled={sending}
            onPress={() => {
              void makeVideo();
            }}
          />
        )}
        <ToolbarButton symbol="trash" label="Delete" tone="overlay" onPress={remove} />
      </View>
      )}

      {isImage && pendingJob === undefined && (
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
  cancel: { position: "absolute", bottom: spacing.lg, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm, borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,255,255,0.5)" },
  pill: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 999, backgroundColor: "rgba(20,20,22,0.8)" },
  strip: { paddingTop: spacing.md },
  actions: { flexDirection: "row", justifyContent: "space-around", paddingHorizontal: spacing.sm, paddingTop: spacing.md },
  bottom: { gap: spacing.sm, paddingTop: spacing.md },
  suggestions: { gap: spacing.sm, paddingHorizontal: spacing.lg },
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginHorizontal: spacing.lg, paddingLeft: spacing.xs, paddingRight: 6, minHeight: 48, borderRadius: 24, backgroundColor: BAR, borderWidth: 1, borderColor: BAR_EDGE },
  input: { flex: 1, color: "#E9ECEF", fontSize: 15, paddingVertical: spacing.sm },
});
