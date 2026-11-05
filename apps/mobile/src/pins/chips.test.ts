import { describe, expect, it } from "vitest";
import type { Artifact } from "@relay/protocol";
import { pinsOf, pinId } from "@relay/protocol";
import { CHIP_LABEL_MAX, CHIP_VALUE_MAX, pinChipText } from "./chips";
import { useArtifactsStore } from "@/state/artifacts";

const pin = (kind: "code" | "number" | "link" | "message" | "text", label: string, value: string): Artifact => ({
  id: pinId(kind, value),
  kind: "pin",
  title: label,
  pin: { kind, label, value },
  mentions: 0,
  firstSeen: 1,
  lastSeen: 1,
  sources: [],
  addedBy: "astra",
  pinned: { by: "astra", at: 5 },
});

describe("pinChipText", () => {
  it("shows a short value beside its label, mono for code and numbers", () => {
    const [code] = pinsOf([pin("code", "Deploy", "bun deploy")]);
    expect(pinChipText(code!)).toEqual({ label: "Deploy", value: "bun deploy", mono: true });
    const [text] = pinsOf([pin("text", "Wifi", "hunter2")]);
    expect(pinChipText(text!)).toEqual({ label: "Wifi", value: "hunter2", mono: false });
  });

  it("keeps long values, multi-line values and whole messages off the chip", () => {
    const [url] = pinsOf([pin("link", "Staging", "https://staging.example.com/login")]);
    expect(pinChipText(url!).value).toBeNull();
    expect("https://staging.example.com/login".length).toBeGreaterThan(CHIP_VALUE_MAX);
    const [multi] = pinsOf([pin("code", "Script", "a\nb")]);
    expect(pinChipText(multi!).value).toBeNull();
    const [message] = pinsOf([pin("message", "Plan", "short")]);
    expect(pinChipText(message!).value).toBeNull();
  });

  it("cuts a long label with an ellipsis", () => {
    const [long] = pinsOf([pin("text", "L".repeat(CHIP_LABEL_MAX + 10), "x")]);
    const text = pinChipText(long!).label;
    expect(text).toHaveLength(CHIP_LABEL_MAX);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("the phone's artifacts store", () => {
  it("drops an unpinned snippet but keeps an unpinned artifact", () => {
    const snippet = pin("number", "Order", "8841");
    const link: Artifact = {
      id: "url:https://a.dev",
      kind: "url",
      title: "a",
      mentions: 1,
      firstSeen: 1,
      lastSeen: 1,
      sources: [],
      addedBy: "extractor",
      pinned: { by: "isaac", at: 2 },
    };
    useArtifactsStore.getState().set("assistant:astra", { items: [snippet, link], tabs: [] });
    useArtifactsStore.getState().pin("assistant:astra", snippet.id, undefined);
    useArtifactsStore.getState().pin("assistant:astra", link.id, undefined);
    const items = useArtifactsStore.getState().threads["assistant:astra"]!.items;
    expect(items.map((item) => item.id)).toEqual([link.id]);
    expect(items[0]!.pinned).toBeUndefined();
  });
});
