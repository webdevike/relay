import { describe, expect, it } from "vitest";
import type { WidgetSpec } from "./widget";
import { gridColumns, isControls } from "./widgetLayout";

const keys: WidgetSpec[] = Array.from({ length: 16 }, (_, i) => ({
  widget: "button",
  label: String(i),
  variant: "secondary",
  reply: String(i),
}));
const stats: WidgetSpec[] = [1, 2, 3, 4].map((n) => ({ widget: "stat", label: "s", value: String(n) }));

describe("gridColumns", () => {
  it("keeps a 4-key keypad row on a phone-width card", () => {
    expect(isControls(keys)).toBe(true);
    // ~390pt screen minus bubble and card padding leaves ~320pt.
    expect(gridColumns(320, 4, 4, keys)).toBe(4);
  });

  it("drops columns before content cells get too thin", () => {
    expect(isControls(stats)).toBe(false);
    expect(gridColumns(320, 8, 4, stats)).toBe(2);
    expect(gridColumns(800, 8, 4, stats)).toBe(4);
  });

  it("uses the requested count before the first measurement", () => {
    expect(gridColumns(0, 8, 3, stats)).toBe(3);
  });
});
