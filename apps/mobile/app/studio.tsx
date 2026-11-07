/**
 * Studio: the library of images made on the host. The title is the project switcher (All images,
 * Favorites, projects, Unsorted); a queue line shows while the GPU is busy; the grid is the view's
 * originals newest first (every favorite in Favorites) with queued and running ones as progress
 * tiles. Tap opens the editor; a long press selects, and the create bar gives way to Favorite,
 * Move, Save and Delete (with Undo).
 */
import { useEffect, useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { SymbolView } from "expo-symbols";
import { studioDescendantCount, studioEtaLabel, type StudioItem, type StudioJob } from "@relay/protocol";
import { requestStudio } from "@/connection";
import { useStudioStore } from "@/state/studio";
import { spacing, useColors, useScheme } from "@/theme";
import { tapHaptic } from "@/lib/haptics";
import { Button } from "@/ui/Button";
import { EmptyState } from "@/ui/EmptyState";
import { MediaTile } from "@/ui/MediaTile";
import { ProgressTile } from "@/ui/ProgressTile";
import { Screen } from "@/ui/Screen";
import { Text } from "@/ui/Text";
import { ToolbarButton } from "@/ui/ToolbarButton";
import { cancelJob, deleteImages, favoriteAssets, moveAssets } from "@/studio/actions";
import { assetLength, saveAssets, useHostBase } from "@/studio/assets";
import { CreateBar } from "@/studio/CreateBar";
import { favoriteValue, gridItems, imageCount, keepVisible, libraryOf, liveView, pendingJobs, queueSummary, switcherRows, toggleSelected, viewName } from "@/studio/library";
import { newProject, pickProject } from "@/studio/pickers";
import { QueueSheet } from "@/studio/QueueSheet";
import { StudioEditor } from "@/studio/StudioEditor";
import { SwitcherSheet } from "@/studio/SwitcherSheet";
import { ToastHost } from "@/studio/ToastHost";

const GAP = spacing.sm;
const COLUMNS = 2;
/** Opaque bar fill in dark mode, as the create bar uses. */
const FILL_DARK = "#202020";

type Cell = { kind: "pending"; job: StudioJob } | { kind: "item"; item: StudioItem };

export default function Studio() {
  const colors = useColors();
  const dark = useScheme() === "dark";
  const { width } = useWindowDimensions();
  const loaded = useStudioStore((state) => state.loaded);
  const jobs = useStudioStore((state) => state.jobs);
  const backends = useStudioStore((state) => state.backends);
  const projects = useStudioStore((state) => state.projects);
  const storedView = useStudioStore((state) => state.view);
  const setView = useStudioStore((state) => state.setView);
  const base = useHostBase();
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [switcher, setSwitcher] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);

  // The host pushes every change while connected; asking on open covers a list missed in between.
  useEffect(() => {
    requestStudio();
  }, []);

  const view = liveView(storedView, projects);
  const library = useMemo(() => libraryOf(jobs), [jobs]);
  const grid = useMemo(() => gridItems(library, view), [library, view]);
  const pending = pendingJobs(jobs, view);
  const queue = queueSummary(jobs);
  const selected = keepVisible(picked, grid);
  const cells: Cell[] = [...pending.map((job) => ({ kind: "pending" as const, job })), ...grid.map((item) => ({ kind: "item" as const, item }))];
  const tile = Math.floor((width - spacing.lg * 2 - GAP * (COLUMNS - 1)) / COLUMNS);
  const busy = queue.running.length + queue.waiting.length + queue.failed.length > 0;

  const endSelect = () => {
    setSelecting(false);
    setPicked([]);
  };
  const press = (id: string) => {
    if (selecting) setPicked(toggleSelected(selected, id));
    else setOpened(id);
  };
  const longPress = (id: string) => {
    setSelecting(true);
    setPicked(selecting ? toggleSelected(selected, id) : [id]);
  };
  const selectedAssets = selected.flatMap((id) => {
    const found = library.lineage.byId.get(id);
    return found === undefined ? [] : [found.asset];
  });
  const favoriting = favoriteValue(selected, library.lineage);

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        {selecting ? (
          <Text variant="title" style={{ flex: 1 }}>
            {selected.length === 0 ? "Select images" : `${selected.length} selected`}
          </Text>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${viewName(view, projects)}, switch project`}
            onPress={() => {
              tapHaptic();
              setSwitcher(true);
            }}
            style={({ pressed }) => [styles.switcher, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text variant="title" numberOfLines={1} style={{ flexShrink: 1 }}>
              {viewName(view, projects)}
            </Text>
            <SymbolView name="chevron.down" size={12} weight="semibold" tintColor={colors.textMuted} />
            <Text variant="label" color="textMuted" tabular numberOfLines={1}>
              {imageCount(grid.length)}
            </Text>
          </Pressable>
        )}
        {selecting ? (
          <>
            <Button
              label="Select all"
              variant="ghost"
              onPress={() => {
                setPicked(grid.map((item) => item.asset.id));
              }}
            />
            <Button label="Done" variant="ghost" onPress={endSelect} />
          </>
        ) : (
          grid.length > 0 && (
            <Button
              label="Select"
              variant="ghost"
              onPress={() => {
                setSelecting(true);
              }}
            />
          )
        )}
      </View>
      {busy && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`GPU queue: ${queue.label}`}
          onPress={() => {
            tapHaptic();
            setQueueOpen(true);
          }}
          style={({ pressed }) => [styles.queue, { opacity: pressed ? 0.6 : 1 }]}
        >
          <SymbolView name="cpu" size={14} tintColor={colors.textMuted} />
          <Text variant="caption" color="textMuted" tabular>
            {queue.label}
          </Text>
          <SymbolView name="chevron.right" size={10} weight="semibold" tintColor={colors.textFaint} />
        </Pressable>
      )}
    </View>
  );

  const renderCell = ({ item: cell }: { item: Cell }) => {
    if (cell.kind === "pending") {
      const { job } = cell;
      const running = job.state === "running";
      const eta = studioEtaLabel(job.etaMs);
      return running ? (
        <ProgressTile size={tile} title={`${Math.min(99, Math.round(job.progress * 100))}%`} details={[...(job.note === undefined ? [] : [job.note]), ...(eta === undefined ? [] : [eta])]} fraction={job.progress} onCancel={() => void cancelJob(job.id)} />
      ) : (
        <ProgressTile size={tile} title="Queued" details={[job.note ?? "Waiting for the GPU"]} fraction={0} onCancel={() => void cancelJob(job.id)} />
      );
    }
    const { asset, job } = cell.item;
    const versions = studioDescendantCount(asset.id, library.lineage);
    const length = assetLength(asset);
    return (
      <MediaTile
        uri={base === null ? null : `${base}${asset.thumb}`}
        size={tile}
        accessibilityLabel={job.spec.prompt}
        selecting={selecting}
        selected={selected.includes(asset.id)}
        favorite={asset.favorite === true}
        leading={length === undefined ? undefined : { icon: "play.fill", label: length }}
        trailing={versions > 0 ? { icon: "arrow.triangle.branch", label: String(versions) } : undefined}
        onPress={() => {
          press(asset.id);
        }}
        onLongPress={() => {
          longPress(asset.id);
        }}
      />
    );
  };

  const waiting = !loaded && backends.length === 0;

  return (
    <Screen header={header}>
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        <View style={styles.fill}>
          {waiting ? (
            <EmptyState symbol="wand.and.stars" title="Waiting for your Mac" body="Studio runs on the host. It shows up here once the phone is connected." />
          ) : (
            <FlatList
              data={cells}
              keyExtractor={(cell) => (cell.kind === "pending" ? `job:${cell.job.id}` : cell.item.asset.id)}
              numColumns={COLUMNS}
              renderItem={renderCell}
              columnWrapperStyle={{ gap: GAP }}
              contentContainerStyle={styles.grid}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <Text variant="body" color="textMuted" style={styles.empty}>
                  {view.kind === "favorites" ? "No favorites yet. Tap the heart on an image to keep it here." : "Nothing here yet. Describe something below and tap Generate."}
                </Text>
              }
            />
          )}
          <ToastHost bottom={spacing.md} />
        </View>
        <View style={styles.dock}>
          {selecting ? (
            <View style={[styles.bulk, { backgroundColor: dark ? FILL_DARK : colors.surface }]}>
              <ToolbarButton
                symbol={favoriting ? "heart" : "heart.fill"}
                label={favoriting ? "Favorite" : "Unfavorite"}
                disabled={selected.length === 0}
                onPress={() => {
                  void favoriteAssets(selected, favoriting);
                }}
              />
              <ToolbarButton
                symbol="folder"
                label="Move"
                disabled={selected.length === 0}
                onPress={() => {
                  const ids = selected;
                  void pickProject("Move to", projects).then((choice) => {
                    if (choice?.kind !== "project") return;
                    endSelect();
                    void moveAssets(ids, choice.id);
                  });
                }}
              />
              <ToolbarButton
                symbol="square.and.arrow.down"
                label="Save"
                disabled={selected.length === 0}
                onPress={() => {
                  void saveAssets(selectedAssets);
                }}
              />
              <ToolbarButton
                symbol="trash"
                label="Delete"
                disabled={selected.length === 0}
                onPress={() => {
                  void deleteImages(selected).then((deleted) => {
                    if (deleted) endSelect();
                  });
                }}
              />
            </View>
          ) : (
            !waiting && <CreateBar />
          )}
        </View>
      </KeyboardAvoidingView>

      <SwitcherSheet
        visible={switcher}
        rows={switcherRows(library, projects)}
        current={view}
        base={base}
        onPick={(next) => {
          setView(next);
          endSelect();
          setSwitcher(false);
        }}
        onNewProject={() => {
          setSwitcher(false);
          void newProject().then((project) => {
            if (project !== undefined) setView({ kind: "project", id: project.id });
          });
        }}
        onClose={() => {
          setSwitcher(false);
        }}
      />
      <QueueSheet
        visible={queueOpen}
        queue={queue}
        backends={backends}
        onClose={() => {
          setQueueOpen(false);
        }}
      />
      <StudioEditor
        assetId={opened}
        onClose={() => {
          setOpened(null);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm, gap: spacing.xs },
  titleRow: { flexDirection: "row", alignItems: "center", minHeight: 44, gap: spacing.xs },
  switcher: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 44 },
  queue: { flexDirection: "row", alignItems: "center", gap: spacing.xs + 2, alignSelf: "flex-start", minHeight: 28 },
  grid: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: GAP },
  empty: { paddingTop: spacing.xxl, textAlign: "center", paddingHorizontal: spacing.xl },
  dock: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.xs },
  bulk: { flexDirection: "row", justifyContent: "space-around", borderRadius: 18, paddingVertical: spacing.md },
});
