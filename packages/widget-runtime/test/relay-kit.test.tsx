// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SYSTEM_SCOPE_NAMES } from "../generated/scope";
import { protoSourceRefusal } from "../src/proto";
import { WidgetRoot } from "../src/runtime/index";
import { systemScope } from "../src/runtime/systems";
import { systemCss } from "../src/systems/css";
import { defaultConfig } from "../src/theme";

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const noop = (): undefined => undefined;
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: noop,
      removeEventListener: noop,
    }) as unknown as MediaQueryList;
  window.ResizeObserver = class {
    observe = noop;
    unobserve = noop;
    disconnect = noop;
  };
});

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

/** Renders `source` in the relay system; returns the page's markup (portals included). */
async function render(source: string): Promise<string> {
  const element = document.createElement("div");
  document.body.append(element);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await act(() => {
    createRoot(element).render(
      <WidgetRoot source={source} config={defaultConfig} colorScheme="dark" system="relay" />,
    );
    return Promise.resolve();
  });
  expect(document.body.innerHTML).not.toContain("Widget error");
  errors.mockRestore();
  return document.body.innerHTML;
}

const KIT = [
  "AssistantAvatar",
  "AssistantCard",
  "ChipStrip",
  "ListEmpty",
  "ListKpis",
  "ListLayoutProvider",
  "ListMarks",
  "ListPill",
  "ListRow",
  "ListStatus",
  "ListTime",
  "RelayMenu",
  "SessionChip",
  "SpecialistChip",
  "TablerIcon",
];

const SAMPLES = {
  assistant:
    '<AssistantCard title="Nova" status="working" face={{ style: "micah", seed: "nova", colors: { paper: "#f4e9d8" } }} age="5m" />',
  chips:
    '<ChipStrip><SpecialistChip label="Web researcher" state="running" clock="0:12"/><SessionChip label="scout" state="done" /></ChipStrip>',
  row: '<ListRow title="x" meta="y" leading={<TablerIcon name="bolt" />} trailing={<ListPill tone="ok">Live</ListPill>} />',
  menu: "<RelayMenu opened><RelayMenu.Target><Button>Open</Button></RelayMenu.Target><RelayMenu.Dropdown><RelayMenu.Item>Rename</RelayMenu.Item></RelayMenu.Dropdown></RelayMenu>",
};

describe("the relay kit", () => {
  it("is the relay system's scope, and only its", () => {
    expect(Object.keys(systemScope("relay")).sort()).toEqual(KIT);
    expect(SYSTEM_SCOPE_NAMES.relay).toEqual(KIT);
    expect(systemScope("mantine")).toEqual({});
    expect(protoSourceRefusal(SAMPLES.assistant, "mantine")).toMatch(/unknown component/);
  });

  it("compiles prototypes that use it", () => {
    for (const source of Object.values(SAMPLES))
      expect(protoSourceRefusal(source, "relay")).toBeNull();
  });

  it("draws Relay Desktop's assistant card, with its portrait on its paper and its status", async () => {
    const html = await render(SAMPLES.assistant);
    expect(html).toContain("eva-asg-card");
    expect(html).toContain('data-status="working"');
    expect(html).toContain('class="eva-asg-art" style="background: rgb(244, 233, 216);"');
    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain('<span class="eva-asg-name">Nova</span>');
    expect(html).toContain("eva-list-spin");
    expect(html).toContain("<span>Working · 5m</span>");
  });

  it("draws an agent's small portrait", async () => {
    const html = await render('<AssistantAvatar face="nova-1" size="sm" />');
    expect(html).toContain('class="eva-pm"');
    expect(html).toContain("eva-as-avatar");
  });

  it("draws the composer's chips in their strip", async () => {
    const html = await render(SAMPLES.chips);
    expect(html).toContain('class="eva-chips"');
    expect(html).toContain("eva-chips-scroller");
    expect(html).toContain(
      'class="eva-chip eva-label" data-kind="specialist" data-state="running"',
    );
    expect(html).toContain('<span class="eva-chip-name">Web researcher</span>');
    expect(html).toContain('<span class="eva-chip-clock">0:12</span>');
    expect(html).toContain('class="eva-chip eva-label" data-state="done"');
  });

  it("draws a list row with a Tabler icon and a pill", async () => {
    const html = await render(SAMPLES.row);
    expect(html).toContain('data-density="comfortable"');
    expect(html).toContain('class="eva-list-leading" data-tile="true"');
    expect(html).toContain("tabler-icon-bolt");
    expect(html).toContain('<span class="eva-list-meta">y</span>');
    expect(html).toContain("eva-list-pill");
  });

  it("draws Relay's menu with the shell's dropdown and items", async () => {
    const html = await render(SAMPLES.menu);
    expect(html).toContain("eva-menu-dropdown");
    expect(html).toContain("eva-menu-item");
    expect(html).toContain("Rename");
  });
});

describe("the relay page CSS", () => {
  const css = systemCss("relay");

  it("is the app's own tokens and kit styles", () => {
    expect(css).toContain("--eva-c-background: var(--mantine-color-body)");
    expect(css).toContain("--eva-kit-control-sm:");
    expect(css).toContain(".eva-label {");
    expect(css).toContain(".eva-list-row {");
    expect(css).toContain(".eva-chip[data-kind='specialist']");
    expect(css).toContain(".eva-menu-item {");
    expect(css).toContain(".eva-as-avatar {");
    expect(css).toContain(":where(.eva-pm > :first-child)");
    expect(css).not.toContain("@font-face");
    expect(css).not.toContain("url(");
    expect(css).not.toContain(".eva-chat-header");
  });

  it("defines every token the kit reads at the page root", () => {
    const rootBlocks = [...css.matchAll(/(?:^|\n):root \{([^}]*)\}/g)].map((m) => m[1]).join("\n");
    const atRoot = new Set([...rootBlocks.matchAll(/(--eva-[\w-]+)\s*:/g)].map((m) => m[1]));
    // The theme's resolver writes these at the root too (theme.ts cssVariablesFor).
    for (const name of ["surface", "muted", "card", "popover", "input"])
      atRoot.add(`--eva-color-${name}`);
    const missing = [...css.matchAll(/var\(\s*(--eva-[\w-]+)\s*\)/g)]
      .map((m) => m[1])
      .filter((name) => name !== undefined && !atRoot.has(name) && name !== "--eva-list-grid");
    expect([...new Set(missing)]).toEqual([]);
    // Scoped in the app (.eva-list), at the root here so a row on its own resolves it.
    expect(rootBlocks).toContain("--eva-list-bg: var(--eva-c-background)");
  });
});
