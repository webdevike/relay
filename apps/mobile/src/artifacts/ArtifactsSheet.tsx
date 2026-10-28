/**
 * The Artifacts sheet: what a thread holds (tickets, PRs, links, drops, files, subagents), in the
 * host's tab bar. Opens at half height and drags up to nearly full. A plain (non-modal) gorhom
 * sheet laid over the screen that owns it: the modal kind never presented on the assistant screen.
 *
 * Tabs scroll sideways in bar order; an agent's tab carries its maker's face and a blue dot until
 * opened; Subagents spins while any runs. Long-press a tab to rename, move or hide it; the trailing
 * menu brings hidden tabs back. Rows: pinned first with who pinned it, quiet status pills, a short
 * "48x, last 10:50 PM"; swipe left for Open and Pin. Media is a two-column grid.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Image, Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView, BottomSheetTextInput, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { useVideoPlayer, VideoView } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isDefaultTab, tabItems, visibleTabs, type Artifact, type ArtifactAction, type AssistantAgent, type AssistantPortrait, type ArtifactKind, type ArtifactTab } from "@relay/protocol";
import { actArtifacts, hostBaseUrl } from "@/connection";
import { ImageViewer, type ViewerImage } from "@/agents/ImageViewer";
import { openExternal } from "@/lib/links";
import { tapHaptic } from "@/lib/haptics";
import { agentPortrait, agentTitle, useAssistantStore } from "@/state/assistant";
import { useArtifactsStore } from "@/state/artifacts";
import { useArtifactsSeenStore } from "@/state/artifactsSeen";
import { useConnectionStore } from "@/state/connection";
import { IconButton } from "@/ui/IconButton";
import { Portrait } from "@/ui/Portrait";
import { Text } from "@/ui/Text";
import { radii, spacing, useColors, withAlpha } from "@/theme";
import {
  countLabel,
  groupRows,
  hostUrl,
  initialTab,
  isVideo,
  linkedLine,
  makerLine,
  mediaTiles,
  metaLine,
  moveIndex,
  repoName,
  rowKey,
  ruleChips,
  searchArtifacts,
  statusPills,
  subagentLine,
  subagentRows,
  videoLength,
  type Pill,
} from "./format";

const SNAP_POINTS = ["50%", "92%"];
const NO_ITEMS: Artifact[] = [];
const NO_TABS: ArtifactTab[] = [];

const KIND_SYMBOL: Record<ArtifactKind, SFSymbol> = {
  linear: "circle.dashed",
  "gh-pr": "arrow.triangle.pull",
  "gh-issue": "smallcircle.filled.circle",
  url: "link",
  drop: "photo",
  image: "photo",
  file: "doc",
  experiment: "flask",
  canvas: "rectangle.3.group",
  branch: "arrow.triangle.branch",
  subagent: "list.bullet.indent",
};

const EMPTY_COPY: Record<string, string> = {
  subagents: "No subagents ran today.",
  links: "Tickets, PRs and pages this thread mentions land here.",
  media: "Pictures and videos from this thread land here.",
  everything: "Nothing in this thread yet.",
};

export interface ArtifactsSheetProps {
  thread: string;
  open: boolean;
  onClose: () => void;
}

function Backdrop(props: BottomSheetBackdropProps) {
  return <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.35} pressBehavior="close" />;
}

/** Render last inside a full-screen container so it lays over the whole screen. */
export function ArtifactsSheet({ thread, open, onClose }: ArtifactsSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const ref = useRef<BottomSheet>(null);
  const snapshot = useArtifactsStore((state) => state.threads[thread]);
  const items = snapshot?.items ?? NO_ITEMS;
  const tabs = snapshot?.tabs ?? NO_TABS;
  const agents = useAssistantStore((state) => state.agents);
  const markSeen = useArtifactsSeenStore((state) => state.markSeen);
  useConnectionStore((state) => state.status);
  const base = hostBaseUrl();
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; start: number } | null>(null);
  const [video, setVideo] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setNow(Date.now());
      markSeen(thread, Date.now());
      ref.current?.snapToIndex(0);
    } else ref.current?.close();
  }, [open, thread, markSeen]);
  // Whatever lands while the sheet shows counts as seen.
  useEffect(() => {
    if (open) markSeen(thread, Date.now());
  }, [open, items, thread, markSeen]);

  const visible = useMemo(() => visibleTabs(tabs), [tabs]);
  const rowsByTab = useMemo(() => {
    const out: Record<string, Artifact[]> = {};
    for (const tab of visible) out[tab.id] = tabItems(tab, items, now);
    return out;
  }, [visible, items, now]);
  const counts = useMemo(() => Object.fromEntries(Object.entries(rowsByTab).map(([id, rows]) => [id, rows.length])), [rowsByTab]);
  const current = initialTab(visible, counts, selected);
  const tab = visible.find((entry) => entry.id === current) ?? null;
  const running = items.some((item) => item.subagent?.state === "running");
  const nameOf = useCallback((agent: string) => agentTitle(agents, agent), [agents]);

  const act = (action: ArtifactAction): void => {
    actArtifacts(thread, action).then(
      (result) => {
        if (!result.ok) Alert.alert("Artifacts", result.error ?? "Your Mac refused that.");
      },
      () => undefined,
    );
  };

  const choose = (next: ArtifactTab): void => {
    tapHaptic();
    setSelected(next.id);
    if (next.fresh === true) act({ op: "tab.update", tab: next.id, fresh: false });
  };

  const tabMenu = (target: ArtifactTab): void => {
    const left = moveIndex(tabs, target.id, -1);
    const right = moveIndex(tabs, target.id, 1);
    const options = ["Rename", "Move left", "Move right", "Hide", "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: target.title, options, cancelButtonIndex: 4, destructiveButtonIndex: 3, disabledButtonIndices: [left === null ? 1 : -1, right === null ? 2 : -1].filter((i) => i >= 0) },
      (index) => {
        if (index === 0) {
          Alert.prompt("Rename tab", undefined, (title) => {
            const trimmed = title.trim();
            if (trimmed !== "" && trimmed !== target.title) act({ op: "tab.update", tab: target.id, title: trimmed.slice(0, 40) });
          }, "plain-text", target.title);
        }
        if (index === 1 && left !== null) act({ op: "tab.update", tab: target.id, index: left });
        if (index === 2 && right !== null) act({ op: "tab.update", tab: target.id, index: right });
        if (index === 3) act({ op: "tab.update", tab: target.id, hidden: true });
      },
    );
  };

  const hiddenMenu = (): void => {
    const hidden = tabs.filter((entry) => entry.hidden);
    if (hidden.length === 0) {
      Alert.alert("No hidden tabs", "Long-press a tab to rename, move or hide it.");
      return;
    }
    ActionSheetIOS.showActionSheetWithOptions(
      { title: "Hidden tabs", message: "Tap one to show it again.", options: [...hidden.map((entry) => `Show ${entry.title}`), "Cancel"], cancelButtonIndex: hidden.length },
      (index) => {
        const target = hidden[index];
        if (target !== undefined) {
          setSelected(target.id);
          act({ op: "tab.update", tab: target.id, hidden: false });
        }
      },
    );
  };

  const openItem = (item: Artifact, list: readonly Artifact[]): void => {
    const url = hostUrl(item.url, base);
    if (item.media !== undefined && url !== null) {
      if (isVideo(item)) {
        setVideo(url);
        return;
      }
      const pictures = list.filter((entry) => entry.media !== undefined && !isVideo(entry) && hostUrl(entry.url, base) !== null);
      setViewer({
        images: pictures.map((entry) => ({ uri: hostUrl(entry.url, base) ?? "", title: entry.title, caption: entry.caption })),
        start: Math.max(0, pictures.findIndex((entry) => entry.id === item.id)),
      });
      return;
    }
    if (url !== null && /^https?:/.test(url)) openExternal(url);
  };

  const pin = (item: Artifact): void => {
    tapHaptic();
    act({ op: "pin", id: item.id, pinned: item.pinned === undefined });
  };

  const rows = tab === null ? NO_ITEMS : (rowsByTab[tab.id] ?? NO_ITEMS);
  const searching = query !== null;
  const results = searching ? searchArtifacts(items, query) : NO_ITEMS;

  let body: ReactNode;
  if (searching) {
    body =
      query.trim() === "" ? null : results.length === 0 ? (
        <Empty text={`Nothing matches "${query.trim()}".`} />
      ) : (
        results.map((item) => <Row key={item.id} item={item} items={items} now={now} nameOf={nameOf} onOpen={() => { openItem(item, results); }} onPin={() => { pin(item); }} />)
      );
  } else if (snapshot === undefined) {
    body = <Empty text={base === null ? "Connect to your Mac to see this thread's artifacts." : "Loading…"} />;
  } else if (tab === null) {
    body = <Empty text="Every tab is hidden. Use the menu at the end of the bar to show one." />;
  } else if (tab.id === "subagents") {
    body = rows.length === 0 ? <Empty text={EMPTY_COPY["subagents"] ?? ""} /> : subagentRows(rows).map(({ item, depth }) => <SubagentRow key={item.id} item={item} depth={depth} now={now} />);
  } else if (tab.id === "media") {
    const tiles = mediaTiles(rows);
    body = tiles.length === 0 ? <Empty text={EMPTY_COPY["media"] ?? ""} /> : <MediaGrid tiles={tiles} base={base} now={now} onOpen={(item) => { openItem(item, tiles); }} />;
  } else {
    const groups = groupRows(tab, rows);
    body = (
      <>
        {!isDefaultTab(tab.id) && <RuleHeader tab={tab} agents={agents} nameOf={nameOf} now={now} />}
        {groups.length === 0 ? (
          <Empty text={EMPTY_COPY[tab.id] ?? "Nothing matches this tab right now."} />
        ) : (
          groups.map((group) => (
            <View key={group.title}>
              <Text variant="label" color="textMuted" style={styles.groupTitle}>
                {group.title === "Pinned" || isDefaultTab(tab.id) ? group.title : countLabel(tab, group.items.length)}
              </Text>
              {group.items.map((item) => (
                <Row key={item.id} item={item} items={items} now={now} nameOf={nameOf} onOpen={() => { openItem(item, group.items); }} onPin={() => { pin(item); }} />
              ))}
            </View>
          ))
        )}
      </>
    );
  }

  return (
    <>
      <BottomSheet
        ref={ref}
        index={-1}
        snapPoints={SNAP_POINTS}
        enableDynamicSizing={false}
        enablePanDownToClose
        topInset={insets.top}
        onChange={(index) => {
          if (index === -1) {
            setQuery(null);
            if (open) onClose();
          }
        }}
        backdropComponent={Backdrop}
        backgroundStyle={{ backgroundColor: colors.surface, borderRadius: radii.lg }}
        handleIndicatorStyle={{ backgroundColor: colors.hairline, width: 36, height: 4 }}
        keyboardBehavior="extend"
      >
        <View style={styles.head}>
          {searching ? (
            <BottomSheetTextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search everything in this thread"
              placeholderTextColor={colors.textFaint}
              autoFocus
              style={[styles.search, { backgroundColor: colors.surfaceRaised, color: colors.text }]}
              accessibilityLabel="Search artifacts"
            />
          ) : (
            <Text variant="title" style={styles.title}>
              Artifacts
            </Text>
          )}
          <IconButton
            symbol={searching ? "xmark" : "magnifyingglass"}
            size={34}
            accessibilityLabel={searching ? "Stop searching" : "Search artifacts"}
            onPress={() => { setQuery(searching ? null : ""); }}
          />
          {!searching && (
            <IconButton symbol="xmark" size={34} accessibilityLabel="Close artifacts" onPress={() => { ref.current?.close(); }} />
          )}
        </View>
        {!searching && snapshot !== undefined && (
          <View style={[styles.bar, { borderBottomColor: colors.hairline }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.barContent}>
              {visible.map((entry) => (
                <TabButton
                  key={entry.id}
                  tab={entry}
                  active={entry.id === current}
                  spinning={entry.id === "subagents" && running}
                  portrait={entry.createdBy !== "default" && entry.createdBy !== "isaac" ? agentPortrait(agents, entry.createdBy) : undefined}
                  maker={nameOf(entry.createdBy)}
                  onPress={() => { choose(entry); }}
                  onLongPress={() => { tabMenu(entry); }}
                />
              ))}
              <Pressable accessibilityRole="button" accessibilityLabel="Hidden tabs" onPress={hiddenMenu} hitSlop={8} style={styles.more}>
                <SymbolView name="ellipsis" size={16} tintColor={colors.textMuted} />
              </Pressable>
            </ScrollView>
          </View>
        )}
        <BottomSheetScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }} keyboardShouldPersistTaps="handled">
          {body}
        </BottomSheetScrollView>
      </BottomSheet>
      <ImageViewer images={viewer?.images ?? null} start={viewer?.start ?? 0} onClose={() => { setViewer(null); }} />
      {video !== null && <VideoModal uri={video} onClose={() => { setVideo(null); }} />}
    </>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <Text color="textMuted" style={styles.empty}>
      {text}
    </Text>
  );
}

function TabButton({
  tab,
  active,
  spinning,
  portrait,
  maker,
  onPress,
  onLongPress,
}: {
  tab: ArtifactTab;
  active: boolean;
  spinning: boolean;
  portrait: AssistantPortrait | undefined;
  maker: string;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${tab.title}${tab.fresh === true ? ", new" : ""}`}
      accessibilityHint="Long-press to rename, move or hide"
      onPress={onPress}
      onLongPress={onLongPress}
      style={[styles.tab, { borderBottomColor: active ? colors.accent : "transparent" }]}
    >
      {spinning && <ActivityIndicator size="small" color={colors.textMuted} style={styles.spinner} />}
      {portrait !== undefined && <Portrait name={maker} portrait={portrait} size={18} />}
      <Text variant="body" color={active ? "text" : "textMuted"} style={active ? styles.tabActive : undefined}>
        {tab.title}
      </Text>
      {tab.fresh === true && <View style={[styles.tabDot, { backgroundColor: colors.accent }]} />}
    </Pressable>
  );
}

function PillView({ pill }: { pill: Pill }) {
  const colors = useColors();
  const text = colors[pill.tone];
  return (
    <View style={[styles.pill, { backgroundColor: pill.tone === "textMuted" ? colors.surfaceRaised : withAlpha(text, 0.12) }]}>
      <Text variant="caption" numberOfLines={1} style={{ color: text }}>
        {pill.label}
      </Text>
    </View>
  );
}

function Row({
  item,
  items,
  now,
  nameOf,
  onOpen,
  onPin,
}: {
  item: Artifact;
  items: readonly Artifact[];
  now: number;
  nameOf: (agent: string) => string;
  onOpen: () => void;
  onPin: () => void;
}) {
  const colors = useColors();
  const swipe = useRef<SwipeableMethods>(null);
  const key = rowKey(item);
  const pills = statusPills(item);
  const pinnedBy = item.pinned === undefined ? null : `pinned by ${item.pinned.by === "isaac" ? "you" : nameOf(item.pinned.by)}`;
  const second = [repoName(item), linkedLine(item, items) ?? metaLine(item, now), pinnedBy].filter((part) => part !== null).join(" · ");
  const tone = pills[0];
  const glyphTint = tone === undefined || tone.tone === "textMuted" ? colors.textFaint : colors[tone.tone];
  const canOpen = item.url !== undefined;
  const close = (then: () => void) => () => {
    swipe.current?.close();
    then();
  };
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={() => (
        <View style={styles.actions}>
          {canOpen && (
            <Pressable accessibilityRole="button" accessibilityLabel="Open" onPress={close(onOpen)} style={[styles.action, { backgroundColor: colors.textMuted }]}>
              <SymbolView name="arrow.up.right.square" size={18} tintColor="#FFFFFF" />
              <Text variant="caption" style={styles.actionText}>Open</Text>
            </Pressable>
          )}
          <Pressable accessibilityRole="button" accessibilityLabel={item.pinned === undefined ? "Pin" : "Unpin"} onPress={close(onPin)} style={[styles.action, { backgroundColor: colors.accent }]}>
            <SymbolView name={item.pinned === undefined ? "pin" : "pin.slash"} size={18} tintColor="#FFFFFF" />
            <Text variant="caption" style={styles.actionText}>{item.pinned === undefined ? "Pin" : "Unpin"}</Text>
          </Pressable>
        </View>
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${key === null ? "" : `${key} `}${item.title}`}
        accessibilityHint="Swipe left for Open and Pin"
        onPress={onOpen}
        style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.surfaceRaised : colors.surface, borderBottomColor: colors.hairline }]}
      >
        <SymbolView name={isVideo(item) ? "play.rectangle" : KIND_SYMBOL[item.kind]} size={16} tintColor={glyphTint} style={styles.rowGlyph} />
        <View style={styles.rowText}>
          <Text numberOfLines={1}>
            {key !== null && key !== item.title && <Text color="textMuted">{`${key} `}</Text>}
            {item.title}
          </Text>
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            {second}
          </Text>
        </View>
        {pills.length > 0 && (
          <View style={styles.pills}>
            {pills.slice(0, 2).map((pill) => (
              <PillView key={pill.label} pill={pill} />
            ))}
          </View>
        )}
      </Pressable>
    </ReanimatedSwipeable>
  );
}

function SubagentRow({ item, depth, now }: { item: Artifact; depth: number; now: number }) {
  const colors = useColors();
  const state = item.subagent?.state;
  return (
    <View style={[styles.row, { paddingLeft: spacing.xl + depth * spacing.xl, borderBottomColor: colors.hairline }]}>
      {state === "running" ? (
        <ActivityIndicator size="small" color={colors.working} style={styles.rowGlyph} />
      ) : (
        <SymbolView
          name={state === "failed" ? "xmark.circle" : "checkmark.circle"}
          size={16}
          tintColor={state === "failed" ? colors.danger : colors.ok}
          style={styles.rowGlyph}
        />
      )}
      <View style={styles.rowText}>
        <Text numberOfLines={1}>{item.title}</Text>
        <Text variant="caption" color="textMuted" numberOfLines={1}>
          {subagentLine(item, now)}
        </Text>
      </View>
    </View>
  );
}

function RuleHeader({ tab, agents, nameOf, now }: { tab: ArtifactTab; agents: AssistantAgent[] | null; nameOf: (agent: string) => string; now: number }) {
  const colors = useColors();
  const chips = tab.items !== undefined ? [`${String(tab.items.length)} picked`] : ruleChips(tab.rule);
  const agent = tab.createdBy !== "isaac" && tab.createdBy !== "default";
  return (
    <View style={[styles.rule, { borderColor: colors.hairline }]}>
      <View style={styles.ruleChips}>
        <SymbolView name="line.3.horizontal.decrease" size={14} tintColor={colors.textMuted} />
        {chips.map((chip, index) => (
          <View key={chip} style={styles.ruleChipRow}>
            {index > 0 && (
              <Text variant="caption" color="textMuted">
                and
              </Text>
            )}
            <View style={[styles.pill, { backgroundColor: colors.surfaceRaised }]}>
              <Text variant="caption">{chip}</Text>
            </View>
          </View>
        ))}
      </View>
      <View style={styles.ruleChips}>
        {agent && <Portrait name={nameOf(tab.createdBy)} portrait={agentPortrait(agents, tab.createdBy)} size={16} />}
        <Text variant="caption" color="textMuted">
          {makerLine(tab, nameOf, now)}
        </Text>
      </View>
    </View>
  );
}

function MediaGrid({ tiles, base, now, onOpen }: { tiles: Artifact[]; base: string | null; now: number; onOpen: (item: Artifact) => void }) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  const tile = (width - spacing.xl * 2 - spacing.md) / 2;
  return (
    <View style={styles.grid}>
      {tiles.map((item) => {
        const src = hostUrl(isVideo(item) ? (item.media?.poster ?? undefined) : item.url, base);
        const length = videoLength(item);
        return (
          <Pressable key={item.id} accessibilityRole="imagebutton" accessibilityLabel={item.caption ?? item.title} onPress={() => { onOpen(item); }} style={{ width: tile }}>
            <View style={[styles.tile, { width: tile, height: tile * 0.75, backgroundColor: colors.surfaceRaised }]}>
              {src !== null && <Image source={{ uri: src }} style={StyleSheet.absoluteFill} resizeMode="cover" />}
              {length !== null && (
                <View style={styles.length}>
                  <SymbolView name="play.fill" size={9} tintColor="#FFFFFF" />
                  <Text variant="caption" tabular style={styles.lengthText}>
                    {length}
                  </Text>
                </View>
              )}
            </View>
            <Text variant="label" numberOfLines={1} style={styles.tileCaption}>
              {item.caption ?? item.title}
            </Text>
            <Text variant="caption" color="textMuted">
              {metaLine({ ...item, mentions: 0 }, now)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function VideoModal({ uri, onClose }: { uri: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer({ uri }, (p) => {
    p.play();
  });
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} supportedOrientations={["portrait", "landscape"]}>
      <View style={styles.video}>
        <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls contentFit="contain" />
        <View style={[styles.videoClose, { top: insets.top + spacing.sm }]}>
          <IconButton symbol="xmark" tone="overlay" accessibilityLabel="Close video" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.xl, paddingBottom: spacing.sm },
  title: { flex: 1 },
  search: { flex: 1, height: 36, borderRadius: radii.md, paddingHorizontal: spacing.md, fontSize: 15 },
  bar: { borderBottomWidth: StyleSheet.hairlineWidth },
  barContent: { paddingHorizontal: spacing.lg, gap: spacing.lg, alignItems: "center" },
  tab: { flexDirection: "row", alignItems: "center", gap: spacing.xs + 2, paddingVertical: spacing.sm + 2, borderBottomWidth: 2 },
  tabActive: { fontWeight: "600" },
  tabDot: { width: 7, height: 7, borderRadius: 4 },
  spinner: { transform: [{ scale: 0.75 }] },
  more: { paddingVertical: spacing.sm, paddingHorizontal: spacing.xs },
  groupTitle: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  rowGlyph: { width: 18, height: 18 },
  rowText: { flex: 1, gap: 2 },
  pills: { alignItems: "flex-end", gap: spacing.xs, maxWidth: "40%" },
  pill: { borderRadius: 999, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  actions: { flexDirection: "row" },
  action: { width: 72, alignItems: "center", justifyContent: "center", gap: 2 },
  actionText: { color: "#FFFFFF" },
  empty: { paddingHorizontal: spacing.xl, paddingVertical: spacing.xxl, textAlign: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, paddingHorizontal: spacing.xl, paddingTop: spacing.sm },
  tile: { borderRadius: radii.md, overflow: "hidden" },
  tileCaption: { marginTop: spacing.xs },
  length: { position: "absolute", right: spacing.xs, bottom: spacing.xs, flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: radii.sm, paddingHorizontal: 5, paddingVertical: 1 },
  lengthText: { color: "#FFFFFF" },
  rule: { marginHorizontal: spacing.xl, marginTop: spacing.md, padding: spacing.md, borderWidth: 1, borderRadius: radii.md, gap: spacing.sm },
  ruleChips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.xs + 2 },
  ruleChipRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs + 2 },
  video: { flex: 1, backgroundColor: "#000" },
  videoClose: { position: "absolute", right: spacing.lg },
});
