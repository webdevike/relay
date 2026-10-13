import { describe, expect, it } from "vitest";
import { parseBlocks } from "./markdown";
import { MAX_CHILDREN, MAX_DEPTH, parseWidget } from "./widget";

describe("parseWidget", () => {
  it("parses a chart spec", () => {
    const spec = parseWidget(
      '{"widget":"chart","kind":"bar","title":"Calls","labels":["M","T"],"series":[{"points":[1,2,3]}]}',
    );
    expect(spec).toEqual({
      widget: "chart",
      kind: "bar",
      title: "Calls",
      labels: ["M", "T"],
      series: [{ points: [1, 2, 3] }],
    });
  });

  it("parses a stat spec and normalises a bad delta direction", () => {
    expect(
      parseWidget(
        '{"widget":"stat","label":"Collected","value":"$7.9k","delta":{"value":"12%","direction":"sideways"}}',
      ),
    ).toEqual({
      widget: "stat",
      label: "Collected",
      value: "$7.9k",
      delta: { value: "12%", direction: "flat" },
    });
  });

  it("parses tickets, degrading a bad stateType and url instead of rejecting the card", () => {
    expect(
      parseWidget(
        '{"widget":"tickets","tickets":[{"id":"ENG-1","title":"T","summary":"S","state":"Doing","stateType":"wip","url":"not a url"}]}',
      ),
    ).toEqual({
      widget: "tickets",
      tickets: [{ id: "ENG-1", title: "T", summary: "S", state: "Doing" }],
    });
    expect(parseWidget('{"widget":"tickets","tickets":[]}')).toBeNull();
    expect(parseWidget('{"widget":"tickets","tickets":[{"id":"ENG-1","title":"T"}]}')).toBeNull();
  });

  it("accepts compare images only as host drop paths or http(s) URLs", () => {
    const spec = (before: string) =>
      parseWidget(
        JSON.stringify({
          widget: "compare",
          before: { src: before, label: "Before" },
          after: { src: "https://x.test/a.png" },
        }),
      );
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
    expect(
      parseWidget('{"widget":"video","src":"https://cdn.x.test/a.mp4","poster":"x.png"}'),
    ).toEqual({
      widget: "video",
      src: "https://cdn.x.test/a.mp4",
    });
    expect(parseWidget('{"widget":"video","src":"/Users/me/clip.mp4"}')).toBeNull();
    expect(parseWidget('{"widget":"video","src":"file:///tmp/clip.mp4"}')).toBeNull();
    expect(parseWidget('{"widget":"video","title":"No source"}')).toBeNull();
    expect(
      parseWidget(
        '{"widget":"stack","children":[{"widget":"video","src":"/tmp/x.mp4"},{"widget":"divider"}]}',
      ),
    ).toBeNull();
  });

  it("parses a gallery, dropping a non-http source link instead of rejecting the image", () => {
    expect(
      parseWidget(
        '{"widget":"gallery","images":[{"src":"https://cdn.x.test/a.png","title":"A","url":"javascript:alert(1)"},{"src":"/drops/abc/tok"}]}',
      ),
    ).toEqual({
      widget: "gallery",
      images: [{ src: "https://cdn.x.test/a.png", title: "A" }, { src: "/drops/abc/tok" }],
    });
    expect(parseWidget('{"widget":"gallery","images":[]}')).toBeNull();
    expect(parseWidget('{"widget":"gallery","images":[{"src":"/Users/me/a.png"}]}')).toBeNull();
  });

  it("parses a PR, degrading unknown statuses and dropping non-http links", () => {
    const spec = parseWidget(
      '{"widget":"pr","repo":"r","number":7,"title":"T","state":"weird","url":"javascript:x","checks":[{"name":"ci","status":"queued"}],"reviewers":[{"name":"Noah","state":"approved"}],"files":[{"file":"a.ts","patch":"@@ -1 +1 @@\\n-a\\n+b"}]}',
    );
    expect(spec).toMatchObject({
      widget: "pr",
      state: "open",
      checks: [{ name: "ci", status: "pending" }],
      reviewers: [{ name: "Noah", state: "approved" }],
    });
    expect((spec as { url?: string }).url).toBeUndefined();
    expect(parseWidget('{"widget":"pr","repo":"r","number":0,"title":"T"}')).toBeNull();
  });

  it("parses a 3D model from a host drop path or https URL, degrading a bad autoRotate", () => {
    expect(
      parseWidget(
        '{"widget":"model","src":"/drops/abc/tok","title":"Chair","caption":"Drag to orbit","autoRotate":true}',
      ),
    ).toEqual({
      widget: "model",
      src: "/drops/abc/tok",
      title: "Chair",
      caption: "Drag to orbit",
      autoRotate: true,
    });
    expect(
      parseWidget('{"widget":"model","src":"https://cdn.x.test/a.glb","autoRotate":"yes"}'),
    ).toEqual({
      widget: "model",
      src: "https://cdn.x.test/a.glb",
    });
  });

  it("rejects a model with a local path or no src", () => {
    expect(parseWidget('{"widget":"model","src":"/Users/me/chair.glb"}')).toBeNull();
    expect(parseWidget('{"widget":"model","src":"file:///tmp/chair.glb"}')).toBeNull();
    expect(parseWidget('{"widget":"model","title":"No source"}')).toBeNull();
  });

  it("parses a recipe with checkable ingredients and separate directions", () => {
    expect(
      parseWidget(
        '{"widget":"recipe","title":"Tacos","meta":["15 minutes","Serves 6"],"ingredients":[{"section":"Tacos","item":"1 lb ground pork"},{"item":"6 corn tortillas"}],"directions":["Mix the pork.","Sear the tacos."],"source":"https://example.com/recipe"}',
      ),
    ).toEqual({
      widget: "recipe",
      title: "Tacos",
      meta: ["15 minutes", "Serves 6"],
      ingredients: [{ section: "Tacos", item: "1 lb ground pork" }, { item: "6 corn tortillas" }],
      directions: ["Mix the pork.", "Sear the tacos."],
      source: "https://example.com/recipe",
    });
    expect(
      parseWidget('{"widget":"recipe","title":"Empty","ingredients":[],"directions":["Cook"]}'),
    ).toBeNull();
    expect(
      parseWidget(
        '{"widget":"recipe","title":"Empty","ingredients":[{"item":"Salt"}],"directions":[]}',
      ),
    ).toBeNull();
  });
  it("parses emails, dropping a non-http url instead of rejecting the row", () => {
    expect(
      parseWidget(
        '{"widget":"emails","emails":[{"from":"A","subject":"S","unread":true,"url":"javascript:alert(1)"}]}',
      ),
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
          {
            widget: "stack",
            direction: "diagonal",
            children: [{ widget: "badge", label: "Live", tone: "neon" }, { widget: "divider" }],
          },
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
    expect(
      parseWidget(
        JSON.stringify({
          widget: "stack",
          children: Array(MAX_CHILDREN + 1).fill({ widget: "divider" }),
        }),
      ),
    ).toBeNull();
  });

  it("rejects unknown widgets, bad JSON, empty series, and non-finite points", () => {
    expect(parseWidget('{"widget":"mystery"}')).toBeNull();
    expect(parseWidget("{not json")).toBeNull();
    expect(parseWidget('{"widget":"chart","kind":"bar","series":[]}')).toBeNull();
    expect(parseWidget('{"widget":"chart","kind":"bar","series":[{"points":["x"]}]}')).toBeNull();
    expect(parseWidget('{"widget":"chart","kind":"pie","series":[{"points":[1]}]}')).toBeNull();
  });
});

// The shared contract's parity fixtures: EvaOS's serde parser tests the same JSON strings.
describe("design-system nodes", () => {
  it("accepts a reply button with its variant and tone", () => {
    expect(
      parseWidget(
        '{"widget":"button","label":"Approve","reply":"approve ENG-1","variant":"primary","tone":"ok"}',
      ),
    ).toEqual({
      widget: "button",
      label: "Approve",
      reply: "approve ENG-1",
      variant: "primary",
      tone: "ok",
    });
  });

  it("degrades an unknown button variant to secondary", () => {
    expect(
      parseWidget('{"widget":"button","label":"Open","url":"https://linear.app","variant":"weird"}'),
    ).toEqual({ widget: "button", label: "Open", url: "https://linear.app", variant: "secondary" });
  });

  it("accepts a table with mixed column and cell shapes", () => {
    expect(
      parseWidget(
        '{"widget":"table","columns":["Item",{"label":"Qty","align":"right"}],"rows":[["Apples",3],[{"text":"Pears","tone":"warn","bold":true},"12"]]}',
      ),
    ).toEqual({
      widget: "table",
      columns: ["Item", { label: "Qty", align: "right" }],
      rows: [
        ["Apples", 3],
        [{ text: "Pears", tone: "warn", bold: true }, "12"],
      ],
    });
  });

  it("clamps progress into 0..max and defaults the tone to accent", () => {
    expect(parseWidget('{"widget":"progress","value":150,"max":120,"label":"Upload"}')).toEqual({
      widget: "progress",
      value: 120,
      max: 120,
      label: "Upload",
      tone: "accent",
    });
    expect(parseWidget('{"widget":"progress","value":-5,"max":0}')).toMatchObject({
      value: 0,
      max: 100,
    });
  });

  it("accepts a check list of plain and detailed items", () => {
    expect(
      parseWidget(
        '{"widget":"list","style":"check","items":["a",{"text":"b","checked":true,"caption":"done"}]}',
      ),
    ).toEqual({
      widget: "list",
      style: "check",
      items: ["a", { text: "b", checked: true, caption: "done" }],
    });
    expect(parseWidget('{"widget":"list","style":"stars","items":["a"]}')).toMatchObject({
      style: "bullet",
    });
  });

  it("degrades an unknown callout tone to accent", () => {
    expect(parseWidget('{"widget":"callout","tone":"nope","text":"Heads up"}')).toEqual({
      widget: "callout",
      text: "Heads up",
      tone: "accent",
    });
  });

  it("drops an out-of-range image aspect and a non-http link", () => {
    expect(
      parseWidget(
        '{"widget":"image","src":"https://x.com/a.png","aspect":9,"url":"javascript:alert(1)"}',
      ),
    ).toEqual({ widget: "image", src: "https://x.com/a.png" });
  });

  it("accepts tabs holding text and code panes", () => {
    expect(
      parseWidget(
        '{"widget":"tabs","tabs":[{"label":"A","children":[{"widget":"text","text":"a"}]},{"label":"B","children":[{"widget":"code","code":"let x = 1","language":"ts"}]}]}',
      ),
    ).toEqual({
      widget: "tabs",
      tabs: [
        { label: "A", children: [{ widget: "text", text: "a" }] },
        { label: "B", children: [{ widget: "code", code: "let x = 1", language: "ts" }] },
      ],
    });
  });

  it("accepts a grid, dropping an avatar's non-media src for initials", () => {
    expect(
      parseWidget(
        '{"widget":"grid","columns":3,"children":[{"widget":"stat","label":"A","value":"1"},{"widget":"avatar","name":"Isaac Smith","src":"file:///x"}]}',
      ),
    ).toEqual({
      widget: "grid",
      columns: 3,
      children: [
        { widget: "stat", label: "A", value: "1" },
        { widget: "avatar", name: "Isaac Smith" },
      ],
    });
    expect(
      parseWidget('{"widget":"grid","columns":5,"children":[{"widget":"divider"}]}'),
    ).toMatchObject({ columns: 2 });
  });

  it("accepts a collapse of timeline, quote, link, and input, filling their defaults", () => {
    expect(
      parseWidget(
        '{"widget":"collapse","title":"More","children":[{"widget":"timeline","items":[{"title":"Merged","time":"2h","tone":"ok"}]},{"widget":"quote","text":"ship it","cite":"Noah"},{"widget":"link","label":"PR","url":"https://github.com"},{"widget":"input","placeholder":"Name","reply":"rename to {value}"}]}',
      ),
    ).toEqual({
      widget: "collapse",
      title: "More",
      open: false,
      children: [
        { widget: "timeline", items: [{ title: "Merged", time: "2h", tone: "ok" }] },
        { widget: "quote", text: "ship it", cite: "Noah" },
        { widget: "link", label: "PR", url: "https://github.com" },
        { widget: "input", placeholder: "Name", button: "Send", reply: "rename to {value}" },
      ],
    });
  });

  it.each([
    ['{"widget":"button","label":"x"}', "a button with no action"],
    ['{"widget":"button","label":"x","url":"https://a.com","reply":"y"}', "a button with both"],
    ['{"widget":"table","columns":["a","b"],"rows":[["only one"]]}', "a short table row"],
    [
      '{"widget":"tabs","tabs":[{"label":"solo","children":[{"widget":"divider"}]}]}',
      "a single tab",
    ],
    ['{"widget":"input","reply":"no placeholder token"}', "an input reply without {value}"],
    ['{"widget":"link","label":"x","url":"ftp://a"}', "a non-http link"],
    ['{"widget":"button","label":"  ","reply":"y"}', "a blank button label"],
  ])("rejects %s (%s)", (json) => {
    expect(parseWidget(json)).toBeNull();
  });

  it("counts grid, tabs, and collapse toward the depth limit", () => {
    // collapse > grid > tabs > card > `inner`
    const nest = (inner: object) =>
      JSON.stringify({
        widget: "collapse",
        title: "a",
        children: [
          {
            widget: "grid",
            children: [
              {
                widget: "tabs",
                tabs: [
                  { label: "x", children: [{ widget: "card", children: [inner] }] },
                  { label: "y", children: [{ widget: "divider" }] },
                ],
              },
            ],
          },
        ],
      });
    expect(parseWidget(nest({ widget: "stack", children: [{ widget: "divider" }] }))).toBeNull();
    expect(parseWidget(nest({ widget: "divider" }))).not.toBeNull();
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
