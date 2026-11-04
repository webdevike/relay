// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  nextOverride,
  parseThemeMessage,
  readOverride,
  resolveScheme,
  startTheme,
  tokenVars,
  tokensFor,
  writeOverride,
} from "../src/theme";

function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function fakeWindow(systemDark: boolean) {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const media = {
    matches: systemDark,
    addEventListener: (_: string, cb: () => void) => void (listeners["media"] ??= []).push(cb),
  };
  const parent = {};
  const win = {
    parent,
    matchMedia: () => media,
    addEventListener: (type: string, cb: (e: unknown) => void) =>
      void (listeners[type] ??= []).push(cb),
  };
  return {
    win: win as unknown as Window,
    parent,
    setSystem(dark: boolean) {
      media.matches = dark;
      for (const cb of listeners["media"] ?? []) cb({});
    },
    post(data: unknown, source: unknown = parent) {
      for (const cb of listeners["message"] ?? []) cb({ data, source });
    },
  };
}

describe("resolveScheme", () => {
  it("prefers the viewer's choice, then the embedding app, then the system", () => {
    expect(resolveScheme({ override: "light", app: "dark", systemDark: true })).toBe("light");
    expect(resolveScheme({ override: null, app: "dark", systemDark: false })).toBe("dark");
    expect(resolveScheme({ override: null, app: "light", systemDark: true })).toBe("light");
    expect(resolveScheme({ override: null, app: null, systemDark: true })).toBe("dark");
    expect(resolveScheme({ override: null, app: null, systemDark: false })).toBe("light");
  });
});

describe("nextOverride", () => {
  it("saves the opposite scheme, and clears the override when flipping back to what the app follows", () => {
    const inputs = { app: "dark" as const, systemDark: false };
    expect(nextOverride(inputs, "dark")).toBe("light");
    expect(nextOverride(inputs, "light")).toBeNull();
    expect(nextOverride({ app: null, systemDark: true }, "dark")).toBe("light");
    expect(nextOverride({ app: null, systemDark: true }, "light")).toBeNull();
  });
});

describe("storage", () => {
  it("round-trips the override and ignores junk or blocked storage", () => {
    const s = storage();
    writeOverride(s, "dark");
    expect(s.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readOverride(s)).toBe("dark");
    writeOverride(s, null);
    expect(readOverride(s)).toBeNull();
    expect(readOverride(storage({ [THEME_STORAGE_KEY]: "purple" }))).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readOverride(blocked)).toBeNull();
    expect(() => writeOverride(blocked, "dark")).not.toThrow();
  });
});

describe("app messages", () => {
  it("parses a scheme with valid colors only", () => {
    expect(
      parseThemeMessage({
        type: "relay.theme",
        scheme: "dark",
        tokens: { body: "#17201a", text: "url(x)", surface: "rgb(29 41 33)" },
      }),
    ).toEqual({
      scheme: "dark",
      tokens: { body: "#17201a", surface: "rgb(29 41 33)" },
    });
    expect(parseThemeMessage({ type: "relay.theme", scheme: "dim" })).toBeNull();
    expect(parseThemeMessage({ type: "canvas.ready" })).toBeNull();
    expect(parseThemeMessage(null)).toBeNull();
  });

  it("maps tokens to the page's variables, and applies them only to the scheme they were sent for", () => {
    expect(tokenVars({ body: "#17201a", text: "#c1c2c5" })).toEqual({
      "--c-bg": "#17201a",
      "--c-fg": "#c1c2c5",
    });
    const msg = { scheme: "dark" as const, tokens: { body: "#17201a" } };
    expect(tokensFor("dark", msg)).toEqual({ body: "#17201a" });
    expect(tokensFor("light", msg)).toEqual({});
    expect(tokensFor("dark", null)).toEqual({});
  });
});

describe("startTheme", () => {
  it("follows the system without an app, then the app's URL scheme, live messages and the viewer's toggle", () => {
    const f = fakeWindow(true);
    const s = storage();
    const theme = startTheme({ doc: document, win: f.win, initialApp: null, storage: s });
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    f.setSystem(false);
    expect(theme.scheme()).toBe("light");

    const seen = vi.fn();
    theme.subscribe(seen);
    f.post({ type: "relay.theme", scheme: "dark", tokens: { body: "#17201a" } });
    expect(theme.scheme()).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--c-bg")).toBe("#17201a");

    // The app switches to light: tokens are replaced, the page follows.
    f.post({ type: "relay.theme", scheme: "light", tokens: {} });
    expect(theme.scheme()).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--c-bg")).toBe("");

    // The viewer toggles against the app: it sticks, even when the app changes again.
    theme.toggle();
    expect(theme.scheme()).toBe("dark");
    expect(s.getItem(THEME_STORAGE_KEY)).toBe("dark");
    f.post({ type: "relay.theme", scheme: "light", tokens: {} });
    expect(theme.scheme()).toBe("dark");
    // Toggling back to what the app shows returns to following it.
    theme.toggle();
    expect(theme.scheme()).toBe("light");
    expect(s.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(seen).toHaveBeenCalled();
  });

  it("starts from the URL's scheme, a saved override beats it, and strangers' messages are ignored", () => {
    const f = fakeWindow(false);
    const theme = startTheme({
      doc: document,
      win: f.win,
      initialApp: "dark",
      storage: storage({ [THEME_STORAGE_KEY]: "light" }),
    });
    expect(theme.scheme()).toBe("light");
    const g = fakeWindow(false);
    const t2 = startTheme({ doc: document, win: g.win, initialApp: "dark", storage: storage() });
    expect(t2.scheme()).toBe("dark");
    g.post({ type: "relay.theme", scheme: "light" }, {});
    expect(t2.scheme()).toBe("dark");
  });
});
