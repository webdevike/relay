import { describe, expect, it } from "vitest";
import { parseBlocks } from "./markdown";
import { parseWidget } from "./widget";

describe("parseWidget", () => {
  it("parses a chart spec", () => {
    const spec = parseWidget('{"widget":"chart","kind":"bar","title":"Calls","labels":["M","T"],"series":[{"points":[1,2,3]}]}');
    expect(spec).toEqual({
      widget: "chart",
      kind: "bar",
      title: "Calls",
      labels: ["M", "T"],
      series: [{ points: [1, 2, 3] }],
    });
  });

  it("parses a stat spec and normalises a bad delta direction", () => {
    expect(parseWidget('{"widget":"stat","label":"Collected","value":"$7.9k","delta":{"value":"12%","direction":"sideways"}}')).toEqual({
      widget: "stat",
      label: "Collected",
      value: "$7.9k",
      delta: { value: "12%", direction: "flat" },
    });
  });

  it("rejects unknown widgets, bad JSON, empty series, and non-finite points", () => {
    expect(parseWidget('{"widget":"mystery"}')).toBeNull();
    expect(parseWidget("{not json")).toBeNull();
    expect(parseWidget('{"widget":"chart","kind":"bar","series":[]}')).toBeNull();
    expect(parseWidget('{"widget":"chart","kind":"bar","series":[{"points":["x"]}]}')).toBeNull();
    expect(parseWidget('{"widget":"chart","kind":"pie","series":[{"points":[1]}]}')).toBeNull();
  });
});

describe("ui fences", () => {
  it("turns a valid ```ui fence into a widget block", () => {
    const blocks = parseBlocks('text\n```ui\n{"widget":"stat","label":"L","value":"9"}\n```');
    expect(blocks).toEqual([
      { kind: "paragraph", inline: [{ text: "text" }] },
      { kind: "widget", spec: { widget: "stat", label: "L", value: "9" } },
    ]);
  });

  it("falls back to a code block when the ui payload is malformed", () => {
    const blocks = parseBlocks("```ui\nnot json\n```");
    expect(blocks).toEqual([{ kind: "code", lang: "ui", code: "not json" }]);
  });
});
