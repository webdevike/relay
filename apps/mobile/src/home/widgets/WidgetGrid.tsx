/**
 * Home's widget grid, behaving like the iOS home screen.
 *
 * Widgets fill pages one screen tall (`paginateWidgets`: as many rows as fit below whatever sits
 * above the grid); more than one page swipes sideways on the shared `Pager`, with `PageDots` under it.
 * Long-press (400 ms, haptic) on a widget lifts it and opens the context menu (`WidgetMenu`): the
 * size row, Edit Home Screen and Remove Widget. Keep holding and move the finger instead, and the
 * menu gives way to jiggle mode with that widget in hand, as on iOS. In jiggle mode every widget
 * wiggles and shows a minus badge; a short hold (150 ms) picks one up to drag, and dropping it on
 * another widget's place on the same page takes that place (the order persists on drop). Carrying
 * it to the screen's edge moves it to the page beyond and turns to that page. Done (in Home's
 * header, `WidgetEditBar`), or a tap on empty grid space, ends jiggle mode, as does leaving Home
 * (except for the Add Widget sheet, which keeps it, as iOS does). "Add Widget" opens the gallery
 * as a native sheet (`/add-widget`).
 * Dragging is not accessible, so each widget carries VoiceOver actions (resize, move up or down,
 * remove, edit) and the menu lists Move Up and Move Down while VoiceOver is on.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  ZoomIn,
  ZoomOut,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { SymbolView } from "expo-symbols";
import { useFocusEffect, useRouter, type Href } from "expo-router";
import { Text } from "@/ui/Text";
import { Button } from "@/ui/Button";
import { impactHaptic, tapHaptic } from "@/lib/haptics";
import { useSettingsStore } from "@/state/settings";
import { spacing, useColors } from "@/theme";
import { IconButton } from "@/ui/IconButton";
import { PageDots } from "@/ui/PageControls";
import { Pager, usePager } from "@/ui/Pager";
import {
  layoutSlots,
  moveToPage,
  moveWidget,
  paginateWidgets,
  slotAt,
  WIDGET_GAP,
  WIDGET_SIZES,
  type GridMetrics,
  type HomeWidget,
  type WidgetSlot,
} from "./layout";
import { SIZE_LABEL, WIDGET_REGISTRY } from "./registry";
import { editWidgets, runWidgetAction, useWidgetUi, type WidgetAction } from "./ui";
import type { WidgetA11y } from "./WidgetParts";

const MENU_HOLD_MS = 400;
const EDIT_HOLD_MS = 150;
/** Travel after the menu opened that turns the hold into a drag. */
const DRAG_SLOP = 10;
const LIFT = 1.05;
const SPRING = { damping: 20, stiffness: 220, mass: 0.9 } as const;
/** Half a wiggle; widgets start out of step so the grid does not swing as one. */
const WIGGLE_MS = 130;
/** The wiggle's sideways travel at a widget's edge, in points; a wider widget turns less. */
const WIGGLE_TRAVEL = 2.4;
/** A held widget whose finger comes this close to the screen's side moves to the page beyond. */
const EDGE_ZONE = 28;
/** Room above each page's first row for a jiggling widget's minus badge and lift. */
const PAGE_TOP = 10;
/** Height of the page-dots strip under the pages. */
const DOTS_ROW = 22;
/** Space below the dots. */
const GRID_BOTTOM = spacing.md;

interface ItemProps {
  widget: HomeWidget;
  slot: WidgetSlot;
  index: number;
  count: number;
  /** The page this widget is on; `slots` holds every page's slots in page-local coordinates. */
  pageIndex: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** Width of the screen the pages slide across, for the edge that turns the page. */
  screenWidth: number;
  editing: boolean;
  editingSV: SharedValue<boolean>;
  slots: SharedValue<WidgetSlot[][]>;
  open: (href: Href) => void;
  onHover: (dragId: string, targetId: string) => void;
  onDrop: () => void;
  onCross: (dragId: string, delta: -1 | 1) => void;
}

function WidgetItem({
  widget,
  slot,
  index,
  count,
  pageIndex,
  hasPrev,
  hasNext,
  screenWidth,
  editing,
  editingSV,
  slots,
  open,
  onHover,
  onDrop,
  onCross,
}: ItemProps) {
  const colors = useColors();
  const reduceMotion = useReducedMotion();
  const setUi = useWidgetUi((state) => state.set);
  const box = useRef<View>(null);
  const spec = WIDGET_REGISTRY[widget.kind];
  const { id } = widget;

  // Resting place (springs to each new slot), and the drag: where it was picked up plus the finger's travel.
  const x = useSharedValue(slot.x);
  const y = useSharedValue(slot.y);
  const w = useSharedValue(slot.width);
  const h = useSharedValue(slot.height);
  const dragging = useSharedValue(false);
  const held = useSharedValue(false);
  const baseX = useSharedValue(0);
  const baseY = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const hovered = useSharedValue<string | null>(null);
  const lift = useSharedValue(1);
  const wiggle = useSharedValue(0);
  // This drag already carried the widget to another page; one move per pick-up.
  const crossed = useSharedValue(false);

  useEffect(() => {
    x.value = withSpring(slot.x, SPRING);
    y.value = withSpring(slot.y, SPRING);
    w.value = withSpring(slot.width, SPRING);
    h.value = withSpring(slot.height, SPRING);
  }, [slot.x, slot.y, slot.width, slot.height, x, y, w, h]);

  useEffect(() => {
    if (!editing || reduceMotion) {
      cancelAnimation(wiggle);
      wiggle.value = withTiming(0, { duration: WIGGLE_MS });
      return;
    }
    wiggle.value = withDelay(
      (index % 3) * 70,
      withRepeat(
        withSequence(
          withTiming(1, { duration: WIGGLE_MS }),
          withTiming(-1, { duration: WIGGLE_MS }),
        ),
        -1,
        true,
      ),
    );
    return () => {
      cancelAnimation(wiggle);
    };
  }, [editing, reduceMotion, index, wiggle]);

  const hold = useCallback(() => {
    impactHaptic();
    setUi({ holding: true });
    box.current?.measureInWindow((mx, my, mw, mh) => {
      setUi({ menu: { id, x: mx, y: my, width: mw, height: mh } });
    });
  }, [id, setUi]);

  const pickUp = useCallback(
    (fromMenu: boolean) => {
      impactHaptic();
      setUi(fromMenu ? { menu: null, editing: true, holding: true } : { holding: true });
    },
    [setUi],
  );

  const release = useCallback(() => {
    setUi({ holding: false });
  }, [setUi]);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .activateAfterLongPress(editing ? EDIT_HOLD_MS : MENU_HOLD_MS)
        .shouldCancelWhenOutside(false)
        .onStart(() => {
          held.value = true;
          baseX.value = x.value;
          baseY.value = y.value;
          startX.value = 0;
          startY.value = 0;
          tx.value = 0;
          ty.value = 0;
          hovered.value = null;
          crossed.value = false;
          if (editingSV.value) {
            dragging.value = true;
            lift.value = withSpring(LIFT, SPRING);
            scheduleOnRN(pickUp, false);
          } else {
            scheduleOnRN(hold);
          }
        })
        .onUpdate((event) => {
          if (!dragging.value) {
            if (
              event.translationX * event.translationX + event.translationY * event.translationY <
              DRAG_SLOP * DRAG_SLOP
            )
              return;
            // Moving on from the menu: it closes and jiggle mode starts with this widget in hand.
            dragging.value = true;
            startX.value = event.translationX;
            startY.value = event.translationY;
            lift.value = withSpring(LIFT, SPRING);
            scheduleOnRN(pickUp, true);
          }
          tx.value = event.translationX - startX.value;
          ty.value = event.translationY - startY.value;
          if (!crossed.value) {
            const delta =
              event.absoluteX < EDGE_ZONE ? -1 : event.absoluteX > screenWidth - EDGE_ZONE ? 1 : 0;
            if ((delta === -1 && hasPrev) || (delta === 1 && hasNext)) {
              crossed.value = true;
              scheduleOnRN(onCross, id, delta);
              return;
            }
          }
          const target = slotAt(
            slots.value[pageIndex] ?? [],
            baseX.value + tx.value + w.value / 2,
            baseY.value + ty.value + h.value / 2,
            id,
          );
          if (target !== hovered.value) {
            hovered.value = target;
            if (target !== null) scheduleOnRN(onHover, id, target);
          }
        })
        .onFinalize(() => {
          if (dragging.value) {
            dragging.value = false;
            x.value = baseX.value + tx.value;
            y.value = baseY.value + ty.value;
            const home = slots.value[pageIndex]?.find((s) => s.id === id);
            if (home !== undefined) {
              x.value = withSpring(home.x, SPRING);
              y.value = withSpring(home.y, SPRING);
            }
            tx.value = 0;
            ty.value = 0;
            scheduleOnRN(onDrop);
          }
          lift.value = withSpring(1, SPRING);
          if (held.value) {
            held.value = false;
            scheduleOnRN(release);
          }
        }),
    [
      editing,
      editingSV,
      slots,
      id,
      pageIndex,
      hasPrev,
      hasNext,
      screenWidth,
      hold,
      pickUp,
      release,
      onHover,
      onDrop,
      onCross,
      crossed,
      x,
      y,
      w,
      h,
      dragging,
      held,
      baseX,
      baseY,
      startX,
      startY,
      tx,
      ty,
      hovered,
      lift,
    ],
  );

  const placed = useAnimatedStyle(() => ({
    width: w.value,
    height: h.value,
    zIndex: dragging.value ? 10 : 0,
    transform: [
      { translateX: dragging.value ? baseX.value + tx.value : x.value },
      { translateY: dragging.value ? baseY.value + ty.value : y.value },
      { scale: lift.value },
      // An edge `w / 2` from the centre travels `WIGGLE_TRAVEL` when turned by travel / (w / 2) radians;
      // the widget in hand holds still.
      {
        rotate: `${dragging.value ? 0 : (wiggle.value * WIGGLE_TRAVEL * 2 * 180) / (Math.PI * Math.max(w.value, 1))}deg`,
      },
    ],
  }));

  const sizes = WIDGET_SIZES[widget.kind];
  const a11y: WidgetA11y = useMemo(
    () => ({
      actions: [
        ...sizes
          .filter((s) => s !== widget.size)
          .map((s) => ({ name: s, label: `Make ${SIZE_LABEL[s].toLowerCase()}` })),
        ...(index > 0 ? [{ name: "up", label: "Move up" }] : []),
        ...(index < count - 1 ? [{ name: "down", label: "Move down" }] : []),
        { name: "remove", label: "Remove widget" },
        ...(editing ? [] : [{ name: "edit", label: "Edit Home Screen" }]),
      ],
      onAction: (name) => {
        runWidgetAction(id, name as WidgetAction);
      },
    }),
    [sizes, widget.size, index, count, editing, id],
  );
  const { Body } = spec;

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      style={[styles.item, placed]}
    >
      <GestureDetector gesture={gesture}>
        <View ref={box} collapsable={false} style={styles.fill}>
          <Body size={widget.size} open={editing ? null : open} a11y={a11y} />
        </View>
      </GestureDetector>
      {editing && (
        <Animated.View
          entering={ZoomIn.duration(160)}
          exiting={ZoomOut.duration(120)}
          style={styles.badgeWrap}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${spec.title} widget`}
            hitSlop={10}
            onPress={() => {
              runWidgetAction(id, "remove");
            }}
            style={[styles.badge, { backgroundColor: colors.textMuted }]}
          >
            <SymbolView name="minus" size={12} weight="bold" tintColor={colors.bg} />
          </Pressable>
        </Animated.View>
      )}
    </Animated.View>
  );
}

/** Done for jiggle mode: a small accent capsule like iOS's. */
function DonePill({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Done editing widgets"
      onPress={onPress}
      style={({ pressed }) => [
        styles.done,
        { backgroundColor: colors.accent, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      <Text variant="label" style={[styles.doneText, { color: colors.bg }]}>
        Done
      </Text>
    </Pressable>
  );
}

function finishEditing() {
  tapHaptic();
  useWidgetUi.getState().set({ editing: false });
}

/** Jiggle mode's controls for Home's header, where iOS keeps them: Add Widget and Done. */
export function WidgetEditBar() {
  const router = useRouter();
  const setUi = useWidgetUi((state) => state.set);
  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(120)}
      style={styles.editBar}
    >
      <IconButton
        symbol="plus"
        size={30}
        accessibilityLabel="Add Widget"
        onPress={() => {
          setUi({ adding: true });
          router.push("/add-widget");
        }}
      />
      <DonePill onPress={finishEditing} />
    </Animated.View>
  );
}

export interface WidgetGridProps {
  /** Visible height of Home's scroll body; a page fills what is left of it below the grid's top. */
  viewportHeight: number;
}

export function WidgetGrid({ viewportHeight }: WidgetGridProps) {
  const router = useRouter();
  const widgets = useSettingsStore((state) => state.homeWidgets);
  const editing = useWidgetUi((state) => state.editing);
  const holding = useWidgetUi((state) => state.holding);
  const setUi = useWidgetUi((state) => state.set);
  // Pages slide edge to edge, so the grid spans the screen; `top` is its offset in Home's scroll content.
  const [frame, setFrame] = useState({ width: 0, top: 0 });
  // The order while a drag is in flight; committed to settings on drop.
  const [preview, setPreview] = useState<HomeWidget[] | null>(null);
  const draft = useRef<HomeWidget[] | null>(null);
  const shown = preview ?? widgets;
  const metrics: GridMetrics = useMemo(
    () => ({ width: Math.max(0, frame.width - spacing.lg * 2), gap: WIDGET_GAP }),
    [frame.width],
  );
  const pageHeight = viewportHeight - frame.top - PAGE_TOP * 2 - DOTS_ROW - GRID_BOTTOM;
  const committed = useMemo(
    () => paginateWidgets(widgets, metrics, pageHeight),
    [widgets, metrics, pageHeight],
  );
  // A drag in flight only reorders its own page, so every page keeps its widgets until the drop.
  const pages = useMemo(() => {
    if (preview === null) return committed;
    const pageOf = new Map(committed.flatMap((page, i) => page.map((w) => [w.id, i] as const)));
    const grouped = committed.map((): HomeWidget[] => []);
    for (const widget of preview) grouped[pageOf.get(widget.id) ?? 0]?.push(widget);
    return grouped;
  }, [preview, committed]);
  const layouts = useMemo(() => pages.map((page) => layoutSlots(page, metrics)), [pages, metrics]);
  const slotsSV = useSharedValue<WidgetSlot[][]>(layouts.map((layout) => layout.slots));
  const editingSV = useSharedValue(editing);
  useEffect(() => {
    slotsSV.value = layouts.map((layout) => layout.slots);
  }, [layouts, slotsSV]);
  useEffect(() => {
    editingSV.value = editing;
  }, [editing, editingSV]);

  const { page, setPage } = usePager(pages.length);
  const shownPage = Math.min(page, Math.max(0, pages.length - 1));
  // Removing widgets can take away the page being shown.
  useEffect(() => {
    if (page !== shownPage) setPage(shownPage);
  }, [page, shownPage, setPage]);
  // What a drag carried to the screen's edge reads, without rebuilding every widget's gesture.
  const latest = useRef({ pages, metrics, pageHeight, page: shownPage });
  useEffect(() => {
    latest.current = { pages, metrics, pageHeight, page: shownPage };
  }, [pages, metrics, pageHeight, shownPage]);

  // Leaving Home ends jiggle mode and drops a menu left open.
  useFocusEffect(
    useCallback(
      () => () => {
        const ui = useWidgetUi.getState();
        ui.set({ editing: ui.adding && ui.editing, menu: null, holding: false });
      },
      [],
    ),
  );

  const open = useCallback(
    (href: Href) => {
      const ui = useWidgetUi.getState();
      if (ui.editing || ui.menu !== null) return;
      tapHaptic();
      router.push(href);
    },
    [router],
  );

  const hover = useCallback((dragId: string, targetId: string) => {
    const base = draft.current ?? useSettingsStore.getState().homeWidgets;
    const to = base.findIndex((w) => w.id === targetId);
    if (to === -1) return;
    const next = moveWidget(base, dragId, to);
    draft.current = next;
    setPreview(next);
  }, []);

  const drop = useCallback(() => {
    const next = draft.current;
    draft.current = null;
    setPreview(null);
    if (next !== null) editWidgets(() => next);
  }, []);

  // The held widget reached the screen's edge: it moves to the next page over and Home turns to it.
  const cross = useCallback(
    (dragId: string, delta: -1 | 1) => {
      const current = latest.current;
      const base = draft.current ?? useSettingsStore.getState().homeWidgets;
      const next = moveToPage(base, current.pages, dragId, delta);
      draft.current = null;
      setPreview(null);
      editWidgets(() => next);
      const landing = paginateWidgets(next, current.metrics, current.pageHeight).findIndex((p) =>
        p.some((w) => w.id === dragId),
      );
      if (landing === -1 || landing === current.page) return;
      // On another page the widget is drawn anew, out of the finger's hold.
      setUi({ holding: false });
      tapHaptic();
      setPage(landing);
    },
    [setUi, setPage],
  );

  const slotOf = new Map(layouts.flatMap((layout) => layout.slots.map((slot) => [slot.id, slot])));
  const indexOf = new Map(shown.map((widget, index) => [widget.id, index]));

  return (
    <View
      style={styles.wrap}
      onLayout={(event) => {
        const { width, y } = event.nativeEvent.layout;
        setFrame((current) =>
          current.width === width && current.top === y ? current : { width, top: y },
        );
      }}
    >
      {frame.width > 0 && viewportHeight > 0 && pages.length > 0 && (
        <>
          <Pager
            width={frame.width}
            page={shownPage}
            onPageChange={setPage}
            scrollEnabled={!holding}
          >
            {pages.map((pageWidgets, p) => (
              <View key={p} style={styles.page}>
                {editing && (
                  <Pressable
                    style={StyleSheet.absoluteFill}
                    onPress={finishEditing}
                    accessible={false}
                  />
                )}
                <View style={{ height: layouts[p]?.height ?? 0 }}>
                  {pageWidgets.map((widget) => {
                    const slot = slotOf.get(widget.id);
                    if (slot === undefined) return null;
                    return (
                      <WidgetItem
                        key={widget.id}
                        widget={widget}
                        slot={slot}
                        index={indexOf.get(widget.id) ?? 0}
                        count={shown.length}
                        pageIndex={p}
                        hasPrev={p > 0}
                        hasNext={p < pages.length - 1}
                        screenWidth={frame.width}
                        editing={editing}
                        editingSV={editingSV}
                        slots={slotsSV}
                        open={open}
                        onHover={hover}
                        onDrop={drop}
                        onCross={cross}
                      />
                    );
                  })}
                </View>
              </View>
            ))}
          </Pager>
          <View style={styles.dots}>
            <PageDots page={shownPage} count={pages.length} />
          </View>
        </>
      )}
      {widgets.length === 0 && (
        <View style={styles.add}>
          <Button
            label="Add Widgets"
            variant="secondary"
            height={44}
            onPress={() => {
              setUi({ adding: true });
              router.push("/add-widget");
            }}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingBottom: GRID_BOTTOM },
  editBar: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  // Room on every side for a jiggling widget's minus badge and lift, inside the pager's clip.
  page: { flexGrow: 1, paddingHorizontal: spacing.lg, paddingVertical: PAGE_TOP },
  dots: { height: DOTS_ROW, justifyContent: "center" },
  item: { position: "absolute", left: 0, top: 0 },
  fill: { flex: 1 },
  badgeWrap: { position: "absolute", left: -7, top: -7 },
  badge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  done: {
    height: 30,
    paddingHorizontal: 16,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  doneText: { fontWeight: "600" },
  add: { paddingTop: spacing.md, paddingHorizontal: spacing.lg },
});
