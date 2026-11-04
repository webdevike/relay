import { beforeEach, describe, expect, it } from "vitest";
import { useLocalRowsStore, localRowsOf, isLocalRow } from "./localRows";
import { bubbleSegments } from "@/agents/markdown";

const portrait = { style: "notionists" as const, seed: "nova" };
const state = () => useLocalRowsStore.getState();

beforeEach(() => {
  useLocalRowsStore.setState({ rows: {} });
});

describe("local rows", () => {
  it("opens one avatar editor per thread as an openui assistant row", () => {
    state().openAvatarEditor("nova", portrait);
    state().openAvatarEditor("nova", portrait);
    const rows = localRowsOf(state(), "nova");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "assistant" });
    expect(isLocalRow(rows[0]?.id ?? "")).toBe(true);
    expect(rows[0]?.text.startsWith("```openui\n")).toBe(true);
    expect(bubbleSegments(rows[0]?.text ?? "").some((segment) => segment.kind === "widget")).toBe(true);
    expect(localRowsOf(state(), "astra")).toEqual([]);
  });

  it("dismisses the row, after which another editor may open", () => {
    state().openAvatarEditor("nova", portrait);
    const id = localRowsOf(state(), "nova")[0]?.id ?? "";
    state().dismiss("nova", "missing");
    expect(localRowsOf(state(), "nova")).toHaveLength(1);
    state().dismiss("nova", id);
    expect(localRowsOf(state(), "nova")).toEqual([]);
    state().openAvatarEditor("nova", portrait);
    expect(localRowsOf(state(), "nova")).toHaveLength(1);
  });

  it("clears a thread's rows without touching another's", () => {
    state().openAvatarEditor("nova", portrait);
    state().openAvatarEditor("astra", { ...portrait, seed: "astra" });
    state().clear("nova");
    expect(localRowsOf(state(), "nova")).toEqual([]);
    expect(localRowsOf(state(), "astra")).toHaveLength(1);
  });
});
