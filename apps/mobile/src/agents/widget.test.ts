import { describe, expect, it } from "vitest";
import { parseBlocks } from "./markdown";
import { MAX_CHILDREN, MAX_DEPTH, parseWidget } from "./widget";

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

  it("parses tickets, degrading a bad stateType and url instead of rejecting the card", () => {
    expect(
      parseWidget('{"widget":"tickets","tickets":[{"id":"ENG-1","title":"T","summary":"S","state":"Doing","stateType":"wip","url":"not a url"}]}'),
    ).toEqual({ widget: "tickets", tickets: [{ id: "ENG-1", title: "T", summary: "S", state: "Doing" }] });
    expect(parseWidget('{"widget":"tickets","tickets":[]}')).toBeNull();
    expect(parseWidget('{"widget":"tickets","tickets":[{"id":"ENG-1","title":"T"}]}')).toBeNull();
  });

  it("accepts compare images only as host drop paths or http(s) URLs", () => {
    const spec = (before: string) =>
      parseWidget(JSON.stringify({ widget: "compare", before: { src: before, label: "Before" }, after: { src: "https://x.test/a.png" } }));
    expect(spec("/drops/abc/tok")).toEqual({
      widget: "compare",
      before: { src: "/drops/abc/tok", label: "Before" },
      after: { src: "https://x.test/a.png" },
    });
    expect(spec("/Users/me/before.png")).toBeNull();
    expect(spec("file:///tmp/before.png")).toBeNull();
    expect(spec("/drops/abc")).toBeNull();
  });

  it("accepts audio only from host drop paths or http(s) URLs", () => {
    expect(parseWidget('{"widget":"audio","title":"Voice","src":"/drops/abc/tok"}')).toEqual({
      widget: "audio",
      title: "Voice",
      src: "/drops/abc/tok",
    });
    expect(parseWidget('{"widget":"audio","src":"/tmp/x.wav"}')).toBeNull();
    expect(parseWidget('{"widget":"audio"}')).toBeNull();
  });

  it("accepts video only from host drop paths or http(s) URLs, stripping unknown fields like its siblings", () => {
    expect(parseWidget('{"widget":"video","title":"Repro","src":"/drops/abc/tok"}')).toEqual({
      widget: "video",
      title: "Repro",
      src: "/drops/abc/tok",
    });
    expect(parseWidget('{"widget":"video","src":"https://cdn.x.test/a.mp4","poster":"x.png"}')).toEqual({
      widget: "video",
      src: "https://cdn.x.test/a.mp4",
    });
    expect(parseWidget('{"widget":"video","src":"/Users/me/clip.mp4"}')).toBeNull();
    expect(parseWidget('{"widget":"video","src":"file:///tmp/clip.mp4"}')).toBeNull();
    expect(parseWidget('{"widget":"video","title":"No source"}')).toBeNull();
    expect(parseWidget('{"widget":"stack","children":[{"widget":"video","src":"/tmp/x.mp4"},{"widget":"divider"}]}')).toBeNull();
  });

  it("parses a gallery, dropping a non-http source link instead of rejecting the image", () => {
    expect(
      parseWidget('{"widget":"gallery","images":[{"src":"https://cdn.x.test/a.png","title":"A","url":"javascript:alert(1)"},{"src":"/drops/abc/tok"}]}'),
    ).toEqual({ widget: "gallery", images: [{ src: "https://cdn.x.test/a.png", title: "A" }, { src: "/drops/abc/tok" }] });
    expect(parseWidget('{"widget":"gallery","images":[]}')).toBeNull();
    expect(parseWidget('{"widget":"gallery","images":[{"src":"/Users/me/a.png"}]}')).toBeNull();
  });

  it("parses emails, dropping a non-http url instead of rejecting the row", () => {
    expect(
      parseWidget('{"widget":"emails","emails":[{"from":"A","subject":"S","unread":true,"url":"javascript:alert(1)"}]}'),
    ).toEqual({ widget: "emails", emails: [{ from: "A", subject: "S", unread: true }] });
    expect(parseWidget('{"widget":"emails","emails":[]}')).toBeNull();
    expect(parseWidget('{"widget":"emails","emails":[{"from":"A"}]}')).toBeNull();
  });

  it("parses nested containers and degrades bad style/tone/direction instead of rejecting", () => {
    const spec = parseWidget(
      JSON.stringify({
        widget: "card",
        title: "Brief",
        children: [
          { widget: "text", text: "Hi", style: "shouty" },
          { widget: "stack", direction: "diagonal", children: [{ widget: "badge", label: "Live", tone: "neon" }, { widget: "divider" }] },
          { widget: "rows", rows: [{ label: "PRs", value: "3", tone: "ok" }] },
        ],
      }),
    );
    expect(spec).toEqual({
      widget: "card",
      title: "Brief",
      children: [
        { widget: "text", text: "Hi" },
        { widget: "stack", children: [{ widget: "badge", label: "Live" }, { widget: "divider" }] },
        { widget: "rows", rows: [{ label: "PRs", value: "3", tone: "ok" }] },
      ],
    });
  });

  it("rejects the whole tree for a bad child, an empty container, or nesting past the depth limit", () => {
    const nest = (depth: number): object =>
      depth === 0 ? { widget: "divider" } : { widget: "stack", children: [nest(depth - 1)] };
    expect(parseWidget(JSON.stringify(nest(MAX_DEPTH)))).not.toBeNull();
    expect(parseWidget(JSON.stringify(nest(MAX_DEPTH + 1)))).toBeNull();
    expect(parseWidget('{"widget":"stack","children":[]}')).toBeNull();
    expect(parseWidget('{"widget":"stack","children":[{"widget":"stat","label":"x"}]}')).toBeNull();
    expect(parseWidget(JSON.stringify({ widget: "stack", children: Array(MAX_CHILDREN + 1).fill({ widget: "divider" }) }))).toBeNull();
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
