// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ECARD_DESIGN } from "../generated/ecard/design";
import {
  PROTO_FRAME_CSP,
  PROTO_SOURCE_MAX,
  protoFrameDocument,
  protoSourceRefusal,
} from "../src/proto";
import { WidgetRoot } from "../src/runtime/index";
import type { DesignSystem } from "../src/systems";
import { RELAY_SYSTEM_CONFIG } from "../src/systems/relay";
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

/** Renders `source` in `system`; returns the markup and the CSS variables Mantine put in the head. */
async function render(
  source: string,
  system: DesignSystem,
  colorScheme: "light" | "dark" = "light",
): Promise<{ html: string; vars: string }> {
  const element = document.createElement("div");
  document.body.append(element);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await act(() => {
    createRoot(element).render(
      <WidgetRoot
        source={source}
        config={defaultConfig}
        colorScheme={colorScheme}
        system={system}
      />,
    );
    return Promise.resolve();
  });
  return {
    html: element.innerHTML,
    vars: [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n"),
  };
}

describe("protoSourceRefusal", () => {
  it("accepts JSX that compiles, with components from Mantine, the system or the code itself", () => {
    expect(protoSourceRefusal("<Button>Go</Button>", "mantine")).toBeNull();
    expect(
      protoSourceRefusal(
        'const [n, setN] = useState(0);\nconst Row = ({ label }: { label: string }) => <Text>{label}</Text>;\nreturn <Stack><Row label="a" /><Table.Tr /><Button onClick={() => setN(n + 1)}>{n}</Button></Stack>;',
        "relay",
      ),
    ).toBeNull();
    expect(
      protoSourceRefusal(
        "<BasePanel><BasePageTitle>Assets</BasePageTitle><BaseButton>New</BaseButton></BasePanel>",
        "ecard",
      ),
    ).toBeNull();
  });

  it("refuses JSX that does not compile, with the parser's reason", () => {
    expect(protoSourceRefusal("return <Button>", "relay")).toMatch(/^does not compile: /);
    expect(protoSourceRefusal("const x = ;\nreturn <Text />", "relay")).toMatch(
      /^does not compile: /,
    );
  });

  it("refuses components that are nowhere in scope, naming them", () => {
    expect(protoSourceRefusal("<Stack><IconCheck /><Button /></Stack>", "relay")).toBe(
      "unknown component <IconCheck>: not in Mantine, @mantine/charts or the design system, and not defined in the code",
    );
    // eCard's components belong to the eCard system only.
    expect(protoSourceRefusal("<BasePanel />", "relay")).toMatch(/unknown component <BasePanel>/);
  });

  it("refuses an empty or oversized prototype", () => {
    expect(protoSourceRefusal("  \n", "mantine")).toBe("the prototype has no JSX");
    expect(protoSourceRefusal(`<Text>${"x".repeat(PROTO_SOURCE_MAX)}</Text>`, "mantine")).toMatch(
      /keep it under/,
    );
  });
});

describe("protoFrameDocument", () => {
  it("is an offline page with the system's CSS and fonts, in the scheme asked for", () => {
    const ecard = protoFrameDocument("<Button>Go</Button>", { system: "ecard", dark: false });
    expect(ecard).toContain(`content="${PROTO_FRAME_CSP}"`);
    expect(PROTO_FRAME_CSP).toContain("default-src 'none'");
    expect(ecard).toContain('data-mantine-color-scheme="light" data-design-system="ecard"');
    expect(ecard).toContain("font-family: 'Inter'");
    expect(ecard).toContain("url(data:font/woff2;base64,");
    expect(ecard).toContain("background-color: var(--color-background-main)");
    expect(ecard).toContain('"system":"ecard"');
    const relay = protoFrameDocument("<Button>Go</Button>", { system: "relay", dark: true });
    expect(relay).toContain('data-mantine-color-scheme="dark"');
    expect(relay).toContain("--eva-c-background: var(--mantine-color-body)");
    expect(relay).not.toContain("font/woff2");
    expect(relay).toContain('"colorScheme":"dark"');
  });
});

describe("design systems in the runtime", () => {
  it("draws eCard with its palette, Button vars and components", async () => {
    const { html, vars } = await render(
      '<BasePanel><BasePageTitle>Platform Assets</BasePageTitle><Button>Upload</Button><Button variant="outlined">Cancel</Button></BasePanel>',
      "ecard",
    );
    expect(html).toContain("Platform Assets");
    expect(html).toContain("ecard-BaseRoles-page-title");
    expect(html).toContain("mantine-Paper-root");
    expect(html).toContain("--button-bg: var(--color-button-main-solid)");
    expect(html).toContain("--button-bd: 1px solid var(--color-button-main-solid)");
    expect(vars).toContain(
      `--mantine-color-primary-6: ${ECARD_DESIGN.theme.colors["primary"]?.[6] ?? "missing"}`,
    );
    expect(vars).toContain("--color-button-main-solid: #4da2e1");
    expect(vars).toContain('--mantine-font-family: "Inter", sans-serif');
  });

  it("draws Relay with Relay Desktop's theme in light and dark", async () => {
    const dark = await render("<Card withBorder><Button>Approve</Button></Card>", "relay", "dark");
    expect(dark.html).toContain("eva-theme-card");
    expect(dark.vars).toContain(`--mantine-color-body: ${RELAY_SYSTEM_CONFIG.semantic.dark.body}`);
    expect(RELAY_SYSTEM_CONFIG.semantic.dark.body).toBe("#17181b");
    expect(RELAY_SYSTEM_CONFIG.focusRing).toBe("never");
  });

  it("draws stock Mantine with no theme of Relay's or eCard's", async () => {
    const { html, vars } = await render("<Card withBorder><Button>Go</Button></Card>", "mantine");
    expect(html).not.toContain("eva-theme-card");
    expect(vars).not.toContain("--color-button-main-solid");
  });
});
