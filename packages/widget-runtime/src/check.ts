/**
 * The host's check on ```mantine-widget JSX it stores (a dashboard tile), without loading Mantine:
 * its own module so the phone and chat widgets don't carry Sucrase's checker.
 */
import { WIDGET_SCOPE_NAMES } from "../generated/scope";
import { checkWidgetSource } from "./runtime/compile";

const KNOWN = new Set(WIDGET_SCOPE_NAMES);

/**
 * Why `source` would not draw as a ```mantine-widget, or null: empty, does not compile, or names a
 * component that is neither in Mantine (core, charts, hooks) nor defined in the code.
 */
export function mantineSourceRefusal(source: string): string | null {
  if (source.trim() === "") return "has no JSX";
  return checkWidgetSource(source, KNOWN);
}
