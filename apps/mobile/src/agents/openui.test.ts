import type { OpenUIRuntime } from "@relay/protocol";
import { describe, expect, it } from "vitest";
import { parseBlocks, type Block } from "./markdown";
import { openUIView, pressButton, syncOpenUIRuntime, type OpenUIView } from "./openui";
import type { ButtonSpec, WidgetSpec } from "./widget";

type OpenUIBlock = Extract<Block, { kind: "openui" }>;

/** The message's one ```openui block, as MessageText hands it to OpenUIBlock. */
function fence(message: string): OpenUIBlock {
  const block = parseBlocks(message).find((b): b is OpenUIBlock => b.kind === "openui");
  if (!block) throw new Error("no openui block");
  return block;
}

/** What OpenUIBlock draws for `message` on first sight. */
function view(message: string): OpenUIView {
  const { code, partial } = fence(message);
  return openUIView(syncOpenUIRuntime(null, code, partial).snapshot(), partial);
}

/** Every node of the rendered tree, depth first. */
function nodes(spec: WidgetSpec | null): WidgetSpec[] {
  if (spec === null) return [];
  const children = "children" in spec && Array.isArray(spec.children) ? spec.children : [];
  return [spec, ...children.flatMap(nodes)];
}

/** The text widgets show, as a reader sees it. */
function renderedText(runtime: OpenUIRuntime): string[] {
  return nodes(runtime.snapshot().node).flatMap((n) => (n.widget === "text" ? [n.text] : []));
}

/** Taps the button labelled `label` in the current tree, as ButtonWidget does. */
function tap(runtime: OpenUIRuntime, label: string): { reply?: string; url?: string } {
  const button = nodes(runtime.snapshot().node).find(
    (n): n is ButtonSpec => n.widget === "button" && n.label === label,
  );
  if (!button) throw new Error(`no button ${label}`);
  return pressButton(button, runtime);
}

const CALCULATOR = `root = Card([screen, keys, clear], "Calculator")
$display = "0"
$cur = ""
$acc = 0
$op = ""
screen = Text($display, "heading")
keys = Grid([k7, k8, k9, kdiv, k4, k5, k6, kmul, k1, k2, k3, ksub, k0, kdot, keq, kadd], 4, "xs")
result = $cur == "" ? $acc : ($op == "+" ? $acc + $cur * 1 : ($op == "-" ? $acc - $cur : ($op == "*" ? $acc * $cur : ($op == "/" ? $acc / $cur : $cur * 1))))
k7 = Button("7", Action([@Set($cur, $cur + "7"), @Set($display, $cur)]))
k8 = Button("8", Action([@Set($cur, $cur + "8"), @Set($display, $cur)]))
k9 = Button("9", Action([@Set($cur, $cur + "9"), @Set($display, $cur)]))
k4 = Button("4", Action([@Set($cur, $cur + "4"), @Set($display, $cur)]))
k5 = Button("5", Action([@Set($cur, $cur + "5"), @Set($display, $cur)]))
k6 = Button("6", Action([@Set($cur, $cur + "6"), @Set($display, $cur)]))
k1 = Button("1", Action([@Set($cur, $cur + "1"), @Set($display, $cur)]))
k2 = Button("2", Action([@Set($cur, $cur + "2"), @Set($display, $cur)]))
k3 = Button("3", Action([@Set($cur, $cur + "3"), @Set($display, $cur)]))
k0 = Button("0", Action([@Set($cur, $cur + "0"), @Set($display, $cur)]))
kdot = Button(".", Action([@Set($cur, $cur + "."), @Set($display, $cur)]))
kdiv = Button("÷", Action([@Set($acc, result), @Set($op, "/"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
kmul = Button("×", Action([@Set($acc, result), @Set($op, "*"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
ksub = Button("−", Action([@Set($acc, result), @Set($op, "-"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
kadd = Button("+", Action([@Set($acc, result), @Set($op, "+"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
keq = Button("=", Action([@Set($acc, result), @Set($op, ""), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "primary")
clear = Button("Clear", @Reset($display, $cur, $acc, $op), null, "subtle")`;

describe("openui fences", () => {
  const brief = [
    'root = Card([stats, Divider(), status], "Morning brief")',
    'stats = Stack([Stat("Open tickets", "12"), Stat("In review", "1", Delta("2", "down"))], "horizontal")',
    'status = Rows([Row("ENG-5533", "In Review", "accent"), Row("ENG-5514", "Waiting on QA", "warn")])',
  ].join("\n");
  const briefSpec = {
    widget: "card",
    title: "Morning brief",
    children: [
      {
        widget: "stack",
        direction: "horizontal",
        children: [
          { widget: "stat", label: "Open tickets", value: "12" },
          { widget: "stat", label: "In review", value: "1", delta: { value: "2", direction: "down" } },
        ],
      },
      { widget: "divider" },
      {
        widget: "rows",
        rows: [
          { label: "ENG-5533", value: "In Review", tone: "accent" },
          { label: "ENG-5514", value: "Waiting on QA", tone: "warn" },
        ],
      },
    ],
  };

  it("keeps an openui fence's source for its runtime, partial while it streams", () => {
    expect(parseBlocks(`text\n\`\`\`openui\n${brief}\n\`\`\``)).toEqual([
      { kind: "paragraph", inline: [{ text: "text" }] },
      { kind: "openui", code: brief, partial: false },
    ]);
    expect(parseBlocks("```openui\nroot = Card(")).toEqual([{ kind: "openui", code: "root = Card(", partial: true }]);
  });

  it("draws a closed fence as the same widget a ```ui fence makes", () => {
    expect(view(`text\n\`\`\`openui\n${brief}\n\`\`\``)).toEqual({ kind: "widget", spec: briefSpec });
    expect(parseBlocks(`\`\`\`ui\n${JSON.stringify(briefSpec)}\n\`\`\``)).toEqual([{ kind: "widget", spec: briefSpec }]);
  });

  it("draws the valid prefix of a still-streaming fence", () => {
    const cut = brief.indexOf('Stat("In review"') + 'Stat("In rev'.length;
    expect(view(`\`\`\`openui\n${brief.slice(0, cut)}`)).toEqual({
      kind: "widget",
      spec: {
        widget: "card",
        title: "Morning brief",
        children: [
          // "horizontal" comes after the children in the stream, so the stack is still vertical.
          { widget: "stack", children: [{ widget: "stat", label: "Open tickets", value: "12" }] },
          { widget: "divider" },
        ],
      },
    });
  });

  it("never flags a streaming fence, even before anything renders", () => {
    for (let end = 0; end <= brief.length; end += 1) {
      const shown = view(`\`\`\`openui\n${brief.slice(0, end)}`);
      expect(shown.kind === "code" ? shown.invalid : false).toBe(false);
    }
  });

  it("drops an invalid child of a closed fence and draws the rest", () => {
    expect(view('```openui\nroot = Card([Stat("Open", "3"), Audio("/tmp/x.wav")], "Mixed")\n```')).toEqual({
      kind: "widget",
      spec: { widget: "card", title: "Mixed", children: [{ widget: "stat", label: "Open", value: "3" }] },
    });
  });

  it("marks a closed fence whose root can't render invalid", () => {
    expect(view('```openui\nroot = Stat("missing value"\n```')).toEqual({ kind: "code", invalid: true });
  });
});

describe("interactive openui widgets", () => {
  it("runs the calculator on the device: 1 2 + 7 = shows 19", () => {
    const { code, partial } = fence(`Here you go:\n\`\`\`openui\n${CALCULATOR}\n\`\`\``);
    const runtime = syncOpenUIRuntime(null, code, partial);
    expect(renderedText(runtime)).toEqual(["0"]);
    let notified = 0;
    runtime.subscribe(() => (notified += 1));
    // Local steps only: nothing to send or open, so no round trip to the host.
    for (const key of ["1", "2", "+"]) expect(tap(runtime, key)).toEqual({});
    expect(renderedText(runtime)).toEqual(["12"]);
    tap(runtime, "7");
    expect(renderedText(runtime)).toEqual(["7"]);
    tap(runtime, "=");
    expect(renderedText(runtime)).toEqual(["19"]);
    // Every tap redraws at once.
    expect(notified).toBe(5);
  });

  it("keeps the calculator's state while the rest of the reply streams in", () => {
    const message = `Here you go:\n\`\`\`openui\n${CALCULATOR}\n\`\`\`\nTap away.`;
    const upToKeys = message.indexOf("k3 = ");
    let runtime: OpenUIRuntime | null = null;
    // The reply arrives a few characters at a time; once its fence opens, the block keeps one
    // runtime throughout.
    for (let end = message.indexOf("```openui") + 10; end <= upToKeys; end += 7) {
      const { code, partial } = fence(message.slice(0, end));
      runtime = syncOpenUIRuntime(runtime, code, partial);
    }
    if (runtime === null) throw new Error("no runtime");
    const first = runtime;
    tap(runtime, "1");
    tap(runtime, "2");
    expect(renderedText(runtime)).toEqual(["12"]);
    for (let end = upToKeys; end <= message.length; end += 7) {
      const { code, partial } = fence(message.slice(0, end));
      runtime = syncOpenUIRuntime(runtime, code, partial);
      expect(renderedText(runtime)).toEqual(["12"]);
    }
    const { code, partial } = fence(message);
    runtime = syncOpenUIRuntime(runtime, code, partial);
    expect(runtime).toBe(first);
    expect(runtime.snapshot().complete).toBe(true);
    tap(runtime, "+");
    tap(runtime, "7");
    tap(runtime, "=");
    expect(renderedText(runtime)).toEqual(["19"]);
  });

  it("passes a plain button's reply or url straight through", () => {
    const runtime = syncOpenUIRuntime(null, 'root = Stack([Button("Yes", @ToAssistant("yes")), Button("Docs", @OpenUrl("https://x.test"))])', false);
    expect(tap(runtime, "Yes")).toEqual({ reply: "yes" });
    expect(tap(runtime, "Docs")).toEqual({ url: "https://x.test" });
    expect(pressButton({ widget: "button", label: "Go", reply: "go", variant: "primary" }, null)).toEqual({ reply: "go" });
  });

  it("shows a bound input's text from the runtime and lets other widgets read it", () => {
    const runtime = syncOpenUIRuntime(null, 'root = Stack([field, Text("Hi " + $name)])\n$name = ""\nfield = Input("Name", "Ask", "Tell me about {value}", false, $name)', false);
    const input = () => nodes(runtime.snapshot().node).find((n) => n.widget === "input");
    expect(input()).toMatchObject({ widget: "input", bind: "field", value: "" });
    runtime.setInput("field", "Ada");
    expect(input()).toMatchObject({ value: "Ada" });
    expect(renderedText(runtime)).toEqual(["Hi Ada"]);
  });
});
