import { beforeEach, describe, expect, it, vi } from "vitest";

const written = vi.hoisted(() => new Map<string, string>());
vi.mock("./storage", () => ({
  fileStorage: {
    getItem: (name: string) => Promise.resolve(written.get(name) ?? null),
    setItem: (name: string, value: string) => {
      written.set(name, value);
    },
    removeItem: (name: string) => {
      written.delete(name);
    },
  },
}));

import { draftKey, useDraftsStore } from "./drafts";

beforeEach(() => {
  useDraftsStore.setState({ drafts: {} });
  written.clear();
});

describe("drafts", () => {
  it("keeps one draft per thread, assistant threads apart from sessions", () => {
    const { setDraft } = useDraftsStore.getState();
    setDraft(draftKey("assistant", "nova"), "Can we move the launch?");
    setDraft(draftKey("session", "nova"), "/handoff");
    expect(useDraftsStore.getState().drafts).toEqual({ "assistant:nova": "Can we move the launch?", "session:nova": "/handoff" });
  });

  it("drops a thread's entry when its draft is emptied (sent)", () => {
    const { setDraft } = useDraftsStore.getState();
    setDraft("assistant:nova", "hi");
    setDraft("assistant:astra", "later");
    setDraft("assistant:nova", "");
    expect(useDraftsStore.getState().drafts).toEqual({ "assistant:astra": "later" });
  });

  it("persists, so a draft outlives the screen and the app", () => {
    useDraftsStore.getState().setDraft("assistant:nova", "half a thought");
    expect(JSON.parse(written.get("relay-drafts") ?? "{}")).toMatchObject({ state: { drafts: { "assistant:nova": "half a thought" } } });
  });

  it("leaves the state untouched when nothing changed", () => {
    const before = useDraftsStore.getState().drafts;
    useDraftsStore.getState().setDraft("assistant:nova", "");
    expect(useDraftsStore.getState().drafts).toBe(before);
  });
});
