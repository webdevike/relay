/**
 * Generative-UI widget specs: the typed, safe payload an agent emits inside a ```ui fence.
 * The phone renders a fixed catalogue of native widgets from these specs — no arbitrary code
 * runs on the device, and rendering is deterministic and instant. Validated with zod so a
 * malformed or hostile payload becomes null (the caller falls back to showing raw code).
 */
import { z } from "zod";

const Series = z.object({
  name: z.string().optional(),
  color: z.string().optional(),
  points: z.array(z.number().finite()).min(1),
});

const Chart = z.object({
  widget: z.literal("chart"),
  kind: z.enum(["bar", "line"]),
  stacked: z.boolean().optional(),
  title: z.string().optional(),
  labels: z.array(z.string()).optional(),
  series: z.array(Series).min(1),
});

const Stat = z.object({
  widget: z.literal("stat"),
  label: z.string(),
  value: z.string(),
  delta: z
    .object({
      value: z.string(),
      direction: z.enum(["up", "down", "flat"]).catch("flat"),
    })
    .optional(),
});

const Widget = z.discriminatedUnion("widget", [Chart, Stat]);

export type Series = z.infer<typeof Series>;
export type ChartSpec = z.infer<typeof Chart>;
export type StatSpec = z.infer<typeof Stat>;
export type WidgetSpec = z.infer<typeof Widget>;

/** Parses and validates a ```ui payload. Returns null on any malformed field so the transcript
 * can fall back to rendering the block as literal code. */
export function parseWidget(text: string): WidgetSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const result = Widget.safeParse(raw);
  return result.success ? result.data : null;
}
