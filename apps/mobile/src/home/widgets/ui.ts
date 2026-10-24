/**
 * Home widgets' transient UI state, shared by the grid (inside Home's scroll view), the long-press
 * menu (an overlay above the whole screen) and Home itself (which holds its scroll still while a
 * widget is held). Not persisted; the layout itself lives in the settings store.
 */
import { create } from "zustand";
import { useSettingsStore } from "@/state/settings";
import { impactHaptic, selectHaptic } from "@/lib/haptics";
import {
  removeWidget,
  resizeWidget,
  shiftWidget,
  type HomeWidget,
  type WidgetSize,
} from "./layout";

/** The widget a long-press opened the menu on, with its box in window coordinates. */
export interface WidgetMenuTarget {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WidgetUiStore {
  /** Jiggle mode: widgets wiggle, show a remove badge and can be dragged. */
  editing: boolean;
  menu: WidgetMenuTarget | null;
  /** A widget is held past the long-press delay; Home's scroll view stays still until release. */
  holding: boolean;
  /** The Add Widget sheet is over Home; leaving Home for it keeps jiggle mode. */
  adding: boolean;
  set: (partial: Partial<Omit<WidgetUiStore, "set">>) => void;
}

export const useWidgetUi = create<WidgetUiStore>((set) => ({
  editing: false,
  menu: null,
  holding: false,
  adding: false,
  set: (partial) => {
    set(partial);
  },
}));

/** Applies a layout change to the persisted widget list. */
export function editWidgets(change: (widgets: readonly HomeWidget[]) => HomeWidget[]): void {
  const settings = useSettingsStore.getState();
  settings.set({ homeWidgets: change(settings.homeWidgets) });
}

/** What the long-press menu and VoiceOver's actions can do to one widget. */
export type WidgetAction = WidgetSize | "up" | "down" | "remove" | "edit";

export function runWidgetAction(id: string, action: WidgetAction): void {
  switch (action) {
    case "small":
    case "medium":
    case "large":
      selectHaptic();
      editWidgets((widgets) => resizeWidget(widgets, id, action));
      return;
    case "up":
    case "down":
      selectHaptic();
      editWidgets((widgets) => shiftWidget(widgets, id, action === "up" ? -1 : 1));
      return;
    case "remove":
      impactHaptic();
      editWidgets((widgets) => removeWidget(widgets, id));
      return;
    case "edit":
      impactHaptic();
      useWidgetUi.getState().set({ editing: true, menu: null });
      return;
  }
}
