/**
 * Home's widget grid, behaving like the iOS home screen.
 *
 * Long-press (400 ms, haptic) on a widget lifts it and opens the context menu (`WidgetMenu`): the
 * size row, Edit Home Screen and Remove Widget. Keep holding and move the finger instead, and the
 * menu gives way to jiggle mode with that widget in hand, as on iOS. In jiggle mode every widget
 * wiggles and shows a minus badge; a short hold (150 ms) picks one up to drag, and dropping it on
 * another widget's place takes that place (the order persists on drop). Done, or a tap on empty
 * grid space, ends jiggle mode, as does leaving Home (except for the Add Widget sheet, which
 * keeps it, as iOS does). "Add Widget" opens the gallery as a native sheet (`/add-widget`).
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
import {
  layoutSlots,
  moveWidget,
  slotAt,
  WIDGET_GAP,
  WIDGET_SIZES,
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

interface ItemProps {
  widget: HomeWidget;
  slot: WidgetSlot;
  index: number;
  count: number;
  editing: boolean;
  editingSV: SharedValue<boolean>;
  slots: SharedValue<WidgetSlot[]>;
  open: (href: Href) => void;
  onHover: (dragId: string, targetId: string) => void;
  onDrop: () => void;
}

function WidgetItem({
  widget,
  slot,
  index,
  count,
  editing,
  editingSV,
  slots,
  open,
  onHover,
  onDrop,
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
          const target = slotAt(
            slots.value,
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
            const home = slots.value.find((s) => s.id === id);
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
      hold,
      pickUp,
      release,
      onHover,
      onDrop,
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

export function WidgetGrid() {
  const router = useRouter();
  const widgets = useSettingsStore((state) => state.homeWidgets);
  const editing = useWidgetUi((state) => state.editing);
  const setUi = useWidgetUi((state) => state.set);
  const [width, setWidth] = useState(0);
  // The order while a drag is in flight; committed to settings on drop.
  const [preview, setPreview] = useState<HomeWidget[] | null>(null);
  const draft = useRef<HomeWidget[] | null>(null);
  const shown = preview ?? widgets;
  const { slots, height } = useMemo(
    () => layoutSlots(shown, { width, gap: WIDGET_GAP }),
    [shown, width],
  );
  const slotsSV = useSharedValue<WidgetSlot[]>(slots);
  const editingSV = useSharedValue(editing);
  useEffect(() => {
    slotsSV.value = slots;
  }, [slots, slotsSV]);
  useEffect(() => {
    editingSV.value = editing;
  }, [editing, editingSV]);

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

  const finish = useCallback(() => {
    tapHaptic();
    setUi({ editing: false });
  }, [setUi]);

  const slotOf = new Map(slots.map((slot) => [slot.id, slot]));

  return (
    <View style={styles.wrap}>
      {editing && <Pressable style={StyleSheet.absoluteFill} onPress={finish} accessible={false} />}
      {editing && (
        <Animated.View
          entering={FadeIn.duration(160)}
          exiting={FadeOut.duration(120)}
          style={styles.editBar}
        >
          <DonePill onPress={finish} />
        </Animated.View>
      )}
      <View
        style={{ height }}
        onLayout={(event) => {
          setWidth(event.nativeEvent.layout.width);
        }}
      >
        {width > 0 &&
          shown.map((widget, index) => {
            const slot = slotOf.get(widget.id);
            if (slot === undefined) return null;
            return (
              <WidgetItem
                key={widget.id}
                widget={widget}
                slot={slot}
                index={index}
                count={shown.length}
                editing={editing}
                editingSV={editingSV}
                slots={slotsSV}
                open={open}
                onHover={hover}
                onDrop={drop}
              />
            );
          })}
      </View>
      {(editing || widgets.length === 0) && (
        <View style={styles.add}>
          <Button
            label={editing ? "Add Widget" : "Add Widgets"}
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
  wrap: { marginHorizontal: spacing.lg, paddingBottom: spacing.lg },
  editBar: { flexDirection: "row", justifyContent: "flex-end", paddingBottom: spacing.md },
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
  add: { paddingTop: spacing.md },
});
