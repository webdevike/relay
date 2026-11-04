import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "..", "src", "style.css"), "utf8");

/** Rules whose selector is part of a live `ui` card or its widgets (`.cv-w-*`, `.cv-ui-*`). */
function widgetRules(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? "").trim();
    if (/\.cv-w-|\.cv-ui-|data-kind="ui"/.test(selector)) out.push({ selector, body: m[2] ?? "" });
  }
  return out;
}

describe("live ui widgets follow the canvas scheme", () => {
  it("draws every widget color from the page's variables, so the scheme switch (toggle, embed, relay.theme) restyles them", () => {
    const rules = widgetRules();
    expect(rules.length).toBeGreaterThan(30);
    const fixed = rules.filter((r) =>
      /(^|[\s:(,])(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|(white|black)(?![-\w]))/i.test(
        r.body.replace(/var\([^)]*\)/g, ""),
      ),
    );
    expect(fixed.map((r) => r.selector)).toEqual([]);
  });

  it("puts the dark palette on the same variables the widgets read", () => {
    const dark = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    for (const name of [
      "--c-bg",
      "--c-fg",
      "--c-muted",
      "--c-border",
      "--c-accent",
      "--c-success",
      "--c-warning",
      "--c-danger",
      "--c-surface",
    ])
      expect(dark).toContain(`${name}:`);
  });
});
