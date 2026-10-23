/**
 * Layout rules for widget containers, kept free of React Native so they are unit-tested: how many
 * columns a grid keeps at a measured width, and how a button sizes inside a grid cell.
 */
import { createContext } from "react";
import type { WidgetSpec } from "./widget";

/** A grid drops columns rather than squeeze a cell narrower than this. */
export const MIN_GRID_CELL = 140;
/** A grid of only buttons, badges or links (a keypad, a choice grid) keeps cells down to this. */
export const MIN_CONTROL_CELL = 56;
/** Buttons in a grid cell: the iOS minimum touch target. */
export const GRID_BUTTON_HEIGHT = 44;

/** Widgets that sit as one control per cell rather than as readable content. */
export const CONTROL_WIDGETS: Partial<Record<WidgetSpec["widget"], true>> = {
  button: true,
  badge: true,
  link: true,
};

export const isControls = (children: readonly WidgetSpec[]): boolean =>
  children.every((child) => CONTROL_WIDGETS[child.widget] === true);

/** Columns a grid shows at `width` (0 = not measured yet): its own count, fewer when cells would
 * get narrower than the minimum for their content. */
export function gridColumns(
  width: number,
  gap: number,
  columns: number,
  children: readonly WidgetSpec[],
): number {
  if (width === 0) return columns;
  const min = isControls(children) ? MIN_CONTROL_CELL : MIN_GRID_CELL;
  return Math.min(columns, Math.max(1, Math.floor((width + gap) / (min + gap))));
}

/** True inside a grid cell: a button there fills the cell at `GRID_BUTTON_HEIGHT`. */
export const GridCellContext = createContext(false);
