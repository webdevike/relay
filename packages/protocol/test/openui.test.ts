import { describe, expect, it } from "vitest";
import { parseOpenUI, relayWidgetPrompt, toOpenUI, WidgetNode, type WidgetSpec } from "../src";
import { checkOpenUIBlocks } from "../src/openui/check-blocks";
import { relayLibrary, WIDGET_KIND_BY_NAME } from "../src/openui/library";
import { OPENUI_EXAMPLES } from "../src/openui/prompt";

const DROP = "/drops/abc/tok";

/** One spec per widget type, every optional field set where it has one. */
const EVERY_TYPE: Record<WidgetSpec["widget"], unknown> = {
  chart: {
    widget: "chart",
    kind: "bar",
    stacked: true,
    title: "Calls",
    labels: ["W1", "W2"],
    series: [{ name: "calls", color: "#A7F3D0", points: [-3.5, 1e-7] }, { points: [2, 4] }],
  },
  stat: { widget: "stat", label: "Collected", value: "$7.9k", delta: { value: "12%", direction: "up" } },
  tickets: {
    widget: "tickets",
    title: "Mine",
    tickets: [
      {
        id: "ENG-1",
        title: "T",
        summary: "S",
        state: "In QA",
        stateType: "started",
        priority: "Low",
        assignee: "Ike",
        updated: "2d ago",
        url: "https://linear.app/x/issue/ENG-1/t",
      },
      { id: "ENG-2", title: "U", summary: "V" },
    ],
  },
  compare: {
    widget: "compare",
    title: "Tabs",
    before: { src: DROP, label: "Before · dev" },
    after: { src: "https://x.com/a.png" },
  },
  audio: { widget: "audio", title: "TTS", src: DROP },
  video: { widget: "video", title: "Clip", src: "https://x.com/v.mp4" },
  gallery: {
    widget: "gallery",
    title: "Refs",
    images: [{ src: DROP, title: "A", caption: "c", url: "https://dribbble.com/shots/1" }, { src: DROP }],
  },
  model: { widget: "model", src: DROP, title: "Mug", caption: "54 KB", autoRotate: true },
  recipe: {
    widget: "recipe",
    title: "Tacos",
    meta: ["15 minutes", "Serves 6"],
    ingredients: [{ section: "Tacos", item: "1 lb pork" }, { item: "6 tortillas" }],
    directions: ["Mix.", "Sear."],
    source: "https://example.com/r",
  },
  text: { widget: "text", text: "Hello", style: "heading" },
  rows: { widget: "rows", rows: [{ label: "a", value: "b", tone: "ok" }, { label: "c", value: "d" }] },
  badge: { widget: "badge", label: "eCard", tone: "accent" },
  divider: { widget: "divider" },
  diff: { widget: "diff", file: "src/a.ts", patch: '@@ -1 +1 @@\n-const a = "x";\n+const a = "y\\n";\n' },
  emails: {
    widget: "emails",
    title: "Inbox",
    emails: [
      { from: "A", subject: "S", snippet: "sn", date: "9:41", unread: true, url: "https://mail.google.com/mail/u/0/#all/1" },
      { from: "B", subject: "T" },
    ],
  },
  pr: {
    widget: "pr",
    repo: "o/r",
    number: 412,
    title: "Fix login",
    state: "draft",
    author: "ike",
    branch: "fix",
    base: "main",
    url: "https://github.com/o/r/pull/412",
    body: "## Why\n\nBecause.",
    reviewers: [{ name: "noah", state: "approved" }, { name: "steve" }],
    checks: [{ name: "lint", status: "success", duration: "42s", url: "https://github.com/o/r/runs/1" }, { name: "e2e" }],
    files: [{ file: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b", additions: 1, deletions: 1 }],
  },
  button: { widget: "button", label: "Nudge", reply: "nudge Noah", variant: "primary", tone: "warn" },
  link: { widget: "link", label: "Docs", url: "https://example.com/docs" },
  image: { widget: "image", src: DROP, alt: "a", caption: "c", url: "https://example.com", aspect: 1.5 },
  table: {
    widget: "table",
    title: "Checks",
    columns: ["Check", { label: "Time", align: "right" }, "PR"],
    rows: [
      ["lint", 42, { text: "#412", url: "https://github.com/o/r/pull/412", icon: "github" }],
      [{ text: "e2e", tone: "danger", bold: true }, "6m", { text: "", icon: "linear" }],
    ],
  },
  progress: { widget: "progress", value: 7, max: 9, label: "Checks", caption: "7 of 9", tone: "ok" },
  list: { widget: "list", style: "check", items: ["one", { text: "two", caption: "c", checked: true }] },
  callout: { widget: "callout", text: "Two approvals needed.", title: "Waiting", tone: "warn" },
  code: { widget: "code", code: 'const s = "q\\"\\\\";\n\ttab é 😀 `t` ${x}', language: "ts", title: "a.ts" },
  quote: { widget: "quote", text: "Ship it.", cite: "Isaac" },
  avatar: { widget: "avatar", name: "Noah", subtitle: "Reviewer", src: DROP },
  timeline: { widget: "timeline", items: [{ title: "Opened", time: "9:00", text: "t", tone: "accent" }, { title: "Merged" }] },
  input: { widget: "input", placeholder: "Name", button: "Go", reply: "call me {value}", multiline: true },
  stack: {
    widget: "stack",
    direction: "horizontal",
    gap: "xs",
    children: [{ widget: "badge", label: "a" }, { widget: "badge", label: "b" }],
  },
  card: { widget: "card", title: "Brief", children: [{ widget: "text", text: "x" }, { widget: "divider" }] },
  grid: { widget: "grid", columns: 3, gap: "lg", children: [{ widget: "stat", label: "a", value: "1" }] },
  tabs: {
    widget: "tabs",
    tabs: [
      { label: "One", children: [{ widget: "text", text: "1" }] },
      { label: "Two", children: [{ widget: "card", children: [{ widget: "text", text: "2" }] }] },
    ],
  },
  collapse: { widget: "collapse", title: "More", open: true, children: [{ widget: "text", text: "hidden" }] },
};

/** The JSON examples of the relay-widgets skill. */
const SKILL_EXAMPLES: unknown[] = [
  {"widget":"chart","kind":"bar","title":"Weekly calls","labels":["W1","W2","W3","W4","W5","W6"],"series":[{"name":"calls","points":[120,180,150,240,300,260]}]},
  {"widget":"chart","kind":"bar","stacked":true,"title":"Calls by outcome","labels":["W1","W2","W3"],"series":[{"name":"connected","color":"#A7F3D0","points":[40,60,55]},{"name":"voicemail","color":"#FDE68A","points":[50,70,60]}]},
  {"widget":"stat","label":"Collected","value":"$7.9k","delta":{"value":"12%","direction":"up"}},
  {"widget":"tickets","title":"My Linear tickets","tickets":[{"id":"ENG-5514","title":"Black Buttons: more stragglers","summary":"Merged; waiting on Steve's QA on dev before closing.","state":"In QA","stateType":"started","priority":"Low","updated":"2d ago","url":"https://linear.app/ecard-systems/issue/ENG-5514/black-buttons-more-stragglers"}]},
  {"widget":"compare","title":"Admin tabs","before":{"src":"/drops/a/b","label":"Before · dev"},"after":{"src":"/drops/c/d","label":"After · local"}},
  {"widget":"audio","title":"Pocket TTS · stuart_bell","src":"/drops/a/b"},
  {"widget":"gallery","title":"Data tables","images":[{"src":"https://cdn.dribbble.com/userupload/1.png?resize=1600x1200","title":"Nested Data Table","caption":"Jon Moore · 561 likes","url":"https://dribbble.com/shots/15627284"}]},
  {"widget":"recipe","title":"Smashed Pork Tacos","meta":["15 minutes","Serves 6"],"ingredients":[{"section":"Tacos","item":"1 lb ground pork"},{"item":"6 corn tortillas"},{"section":"Glaze","item":"3 tbsp soy sauce"}],"directions":["Mix and portion the pork.","Sear each taco meat-side down."],"source":"https://example.com/recipe"},
  {"widget":"model","title":"Mug on a coaster","src":"/drops/a/b","caption":"Blender export · 54 KB","autoRotate":true},
  {"widget":"card","title":"Morning brief","children":[{"widget":"stack","direction":"horizontal","children":[{"widget":"stat","label":"Open tickets","value":"12"},{"widget":"stat","label":"In review","value":"1"}]},{"widget":"divider"},{"widget":"rows","rows":[{"label":"ENG-5533","value":"In Review","tone":"accent"},{"label":"ENG-5514","value":"Waiting on QA","tone":"warn"}]},{"widget":"stack","direction":"horizontal","gap":"xs","children":[{"widget":"badge","label":"eCard","tone":"accent"},{"widget":"badge","label":"Dev green","tone":"ok"}]}]},
  {"widget":"card","title":"ENG-6211 review","children":[{"widget":"callout","tone":"warn","title":"Waiting on Noah","text":"Two approvals needed before merge."},{"widget":"table","columns":["Check",{"label":"Time","align":"right"}],"rows":[["lint","42s"],[{"text":"e2e","tone":"danger","bold":true},"6m"]]},{"widget":"progress","label":"Checks","value":7,"max":9,"tone":"ok"},{"widget":"stack","direction":"horizontal","children":[{"widget":"button","label":"Nudge Noah","reply":"nudge Noah on ENG-6211","variant":"primary"},{"widget":"button","label":"Open PR","url":"https://github.com"}]}]},
  {"widget":"table","columns":["PR","Issue","Title","State"],"rows":[[{"text":"#412","url":"https://github.com/o/r/pull/412","icon":"github"},{"text":"ENG-6211","url":"https://linear.app/team/issue/ENG-6211","icon":"linear"},"Fix login","In review"]]},
];

/** A large tree for the streaming test: nested containers, tabs, tables, actions. */
const LARGE: unknown = {
  widget: "card",
  title: "Release dashboard",
  children: [
    { widget: "grid", columns: 3, children: [
      { widget: "stat", label: "Open", value: "12", delta: { value: "3", direction: "down" } },
      { widget: "stat", label: "Merged", value: "41" },
      { widget: "stat", label: "Failing", value: "2", delta: { value: "1", direction: "up" } },
    ] },
    { widget: "tabs", tabs: [
      { label: "Checks", children: [
        EVERY_TYPE.table,
        { widget: "progress", label: "Checks", value: 7, max: 9, tone: "ok" },
      ] },
      { label: "Tickets", children: [EVERY_TYPE.tickets, EVERY_TYPE.rows] },
      { label: "Activity", children: [EVERY_TYPE.timeline, EVERY_TYPE.chart] },
    ] },
    EVERY_TYPE.callout,
    { widget: "collapse", title: "Details", children: [EVERY_TYPE.list, EVERY_TYPE.code] },
    { widget: "stack", direction: "horizontal", children: [
      EVERY_TYPE.button,
      { widget: "button", label: "Open PR", url: "https://github.com/o/r/pull/412" },
      { widget: "button", label: "Thanks", reply: "thanks" },
    ] },
  ],
};

/** Widgets in a tree, containers and tab panes included. */
function countNodes(node: WidgetSpec | null): number {
  if (node === null) return 0;
  if ("children" in node) return 1 + node.children.reduce((n, c) => n + countNodes(c), 0);
  if (node.widget === "tabs")
    return 1 + node.tabs.reduce((n, t) => n + t.children.reduce((m, c) => m + countNodes(c), 0), 0);
  return 1;
}

function roundTrip(json: unknown): void {
  const spec = WidgetNode.parse(json);
  const program = toOpenUI(spec);
  const result = parseOpenUI(program);
  expect(result.errors, program).toEqual([]);
  expect(result.complete).toBe(true);
  expect(result.node, program).toEqual(spec);
}

describe("OpenUI library", () => {
  it("has one component per widget type", () => {
    expect(new Set(WIDGET_KIND_BY_NAME.values())).toEqual(new Set(Object.keys(EVERY_TYPE)));
  });

  it("lists every component in exactly one prompt group", () => {
    const grouped = relayLibrary.componentGroups?.flatMap((g) => g.components) ?? [];
    expect([...grouped].sort()).toEqual(Object.keys(relayLibrary.components).sort());
  });
});

describe("parseOpenUI / toOpenUI round trip", () => {
  for (const [kind, json] of Object.entries(EVERY_TYPE)) it(kind, () => { roundTrip(json); });
  SKILL_EXAMPLES.forEach((json, i) => {
    it(`skill example ${String(i + 1)}`, () => { roundTrip(json); });
  });
  it("puts statements top-down from root", () => {
    const program = toOpenUI(WidgetNode.parse(SKILL_EXAMPLES[9]));
    expect(program.split("\n").map((line) => line.split(" = ")[0])).toEqual([
      "root", "stack1", "stat1", "stat2", "rows1", "stack2", "badge1", "badge2",
    ]);
  });
});

describe("parseOpenUI", () => {
  it("parses the prompt examples without errors", () => {
    for (const example of OPENUI_EXAMPLES) {
      const result = parseOpenUI(example.program);
      expect(result.errors, example.title).toEqual([]);
      expect(result.complete).toBe(true);
      expect(result.node).not.toBeNull();
    }
  });

  it("drops invalid children, keeping the rest", () => {
    const result = parseOpenUI(
      'root = Card([s, Image("/tmp/x.png"), Row("a", "b"), Link("x", "not a url"), Text("ok")])\ns = Stat("a", "1")',
    );
    expect(result.node).toEqual({
      widget: "card",
      children: [{ widget: "stat", label: "a", value: "1" }, { widget: "text", text: "ok" }],
    });
    expect(result.errors.map((e) => [e.code, e.component])).toEqual([
      ["invalid-widget", "Image"],
      ["not-a-widget", "Row"],
      ["invalid-widget", "Link"],
    ]);
  });

  it("drops a container whose children all fail, then its parent keeps going", () => {
    const result = parseOpenUI('root = Stack([Card([Image("nope")]), Text("x")])');
    expect(result.node).toEqual({ widget: "stack", children: [{ widget: "text", text: "x" }] });
    expect(result.errors.map((e) => e.component)).toEqual(["Image", "Card"]);
  });

  it("returns null for a missing or invalid root", () => {
    expect(parseOpenUI('root = Link("x", "nope")').node).toBeNull();
    expect(parseOpenUI("root = Card([])").node).toBeNull();
    const none = parseOpenUI("just prose");
    expect(none.node).toBeNull();
    expect(none.errors.map((e) => e.code)).toEqual(["no-root"]);
    expect(parseOpenUI("").node).toBeNull();
  });

  it("drops unknown components and invalid enum values", () => {
    const result = parseOpenUI('root = Stack([Foo(1), Badge("a", "neon")])');
    expect(result.node).toEqual({ widget: "stack", children: [{ widget: "badge", label: "a" }] });
    expect(result.errors.map((e) => e.code).sort()).toEqual(["type-mismatch", "unknown-component"]);
  });

  it("maps button actions", () => {
    const result = parseOpenUI(
      'root = Stack([Button("Go"), Button("A", Action([@OpenUrl("https://a.com"), @ToAssistant("x")])), Button("B", null, "https://b.com"), Button("C", @ToAssistant("see"))])',
    );
    expect(result.node).toMatchObject({
      children: [
        { label: "Go", reply: "Go" },
        { label: "A", url: "https://a.com" },
        { label: "B", url: "https://b.com" },
        { label: "C", reply: "see" },
      ],
    });
  });

  it("rejects expressions", () => {
    const result = parseOpenUI('root = Stack([Text("a" + "b"), Text("c")])');
    expect(result.node).toEqual({ widget: "stack", children: [{ widget: "text", text: "c" }] });
    expect(result.errors[0]?.code).toBe("unsupported-expression");
  });

  it("reports unresolved and orphaned statements unless partial", () => {
    const text = 'root = Card([a, b])\na = Text("x")\nc = Text("y")';
    const full = parseOpenUI(text);
    expect(full.complete).toBe(false);
    expect(full.node).toEqual({ widget: "card", children: [{ widget: "text", text: "x" }] });
    expect(full.errors.map((e) => [e.code, e.statementId, e.severity])).toEqual([
      ["unresolved", "b", undefined],
      ["orphaned", "c", "warning"],
    ]);
    expect(parseOpenUI(text, { partial: true }).errors).toEqual([]);
  });

  const HAND_WRITTEN = `root = Card([head, Stack([Button("Retry"), Button("Docs", @OpenUrl("https://example.com/docs")), Button("Ask", Action([@ToAssistant("why?")]))], "horizontal"), chart], "Inline")
head = Text("Streaming -12.5e-3 \\"quoted\\" text", "heading")
chart = Chart("line", [Series([-1.25, 2e3, 3.5], "a")], ["x", "y", "z"])`;

  const streams = [
    toOpenUI(WidgetNode.parse(LARGE)),
    HAND_WRITTEN,
    ...OPENUI_EXAMPLES.map((e) => e.program),
  ];
  streams.forEach((program, i) => {
    it(`streams program ${String(i + 1)}: every prefix parses and the tree only grows`, () => {
      const full = parseOpenUI(program);
      expect(full.errors).toEqual([]);
      let last = 0;
      for (let end = 0; end <= program.length; end++) {
        const result = parseOpenUI(program.slice(0, end), { partial: true });
        const count = countNodes(result.node);
        expect(count, program.slice(0, end)).toBeGreaterThanOrEqual(last);
        last = count;
      }
      expect(parseOpenUI(program, { partial: true }).node).toEqual(full.node);
      expect(last).toBe(countNodes(full.node));
    });
  });
});

describe("checkOpenUIBlocks", () => {
  it("checks closed and unclosed blocks", () => {
    const reply = [
      "Here you go:",
      "```openui",
      'root = Stat("Open", "12")',
      "```",
      "and a broken one",
      "```openui",
      'root = Link("x", "nope")',
      "```",
      "```ui",
      "{}",
      "```",
      "```openui",
      'root = Text("stream',
    ].join("\n");
    const blocks = checkOpenUIBlocks(reply);
    expect(blocks.map((b) => [b.line, b.unclosed, b.ok, b.widget])).toEqual([
      [2, false, true, "stat"],
      [6, false, false, null],
      [12, true, true, "text"],
    ]);
  });
});

describe("relayWidgetPrompt", () => {
  it("documents every component and the openui fence", () => {
    const prompt = relayWidgetPrompt();
    for (const name of Object.keys(relayLibrary.components)) expect(prompt).toContain(`\n${name}(`);
    expect(prompt).toContain("```openui");
    expect(prompt).not.toContain("Query(");
  });
});
