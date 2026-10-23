import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenUIRuntime, parseOpenUI, parseWidget, type OpenUIRuntime, type WidgetSpec } from "../src";
import { CALCULATOR } from "../src/openui/prompt";

const KEY_IDS: Record<string, string> = { "+": "kadd", "-": "ksub", "*": "kmul", "/": "kdiv", "=": "keq", ".": "kdot" };

/** Taps the calculator keys of `keys`, e.g. "12+7*2=". */
function press(runtime: OpenUIRuntime, keys: string): void {
  for (const key of keys) expect(runtime.dispatch(KEY_IDS[key] ?? `k${key}`)).toEqual({});
}

function display(runtime: OpenUIRuntime): string | undefined {
  const node = runtime.snapshot().node;
  const screen = node?.widget === "card" ? node.children[0] : undefined;
  return screen?.widget === "text" ? screen.text : undefined;
}

/** Every button's `action` id in tree order. */
function actionIds(node: WidgetSpec | null): string[] {
  if (!node) return [];
  if (node.widget === "button") return node.action === undefined ? [] : [node.action];
  if ("children" in node) return node.children.flatMap(actionIds);
  return [];
}

describe("createOpenUIRuntime", () => {
  it("runs the calculator: 12+7*2= applies each operator to the running total", () => {
    const runtime = createOpenUIRuntime(CALCULATOR);
    expect(runtime.snapshot().errors).toEqual([]);
    expect(display(runtime)).toBe("0");
    press(runtime, "12");
    expect(display(runtime)).toBe("12");
    press(runtime, "+7");
    expect(display(runtime)).toBe("7");
    press(runtime, "*");
    expect(display(runtime)).toBe("19");
    press(runtime, "2=");
    expect(display(runtime)).toBe("38");
    press(runtime, "/4=");
    expect(display(runtime)).toBe("9.5");
    press(runtime, "0.1+0.2=");
    expect(display(runtime)).toBe("0.3");
  });

  it("resets to the declared defaults", () => {
    const runtime = createOpenUIRuntime(CALCULATOR);
    press(runtime, "9*9=");
    expect(display(runtime)).toBe("81");
    expect(runtime.dispatch("clear")).toEqual({});
    expect(display(runtime)).toBe("0");
    press(runtime, "3+4=");
    expect(display(runtime)).toBe("7");
  });

  it("keeps state while the program streams in", () => {
    const counter = `root = Card([label, inc, more], "Counter")
$count = 0
$step = 1
label = Text("Count: " + $count)
inc = Button("+1", @Set($count, $count + $step))
more = Text("tap to count", "muted")`;
    const cut = counter.indexOf("more =");
    const runtime = createOpenUIRuntime(counter.slice(0, cut), { partial: true });
    runtime.dispatch("inc");
    runtime.dispatch("inc");
    for (let end = cut + 1; end <= counter.length; end++) runtime.update(counter.slice(0, end), { partial: true });
    runtime.update(counter.replace("$step = 1", "$step = 5"));
    const node = runtime.snapshot().node;
    expect(runtime.snapshot().errors).toEqual([]);
    expect(node).toMatchObject({ children: [{ text: "Count: 2" }, { action: "inc" }, { text: "tap to count" }] });
    // An untouched $variable takes its new default; a changed one keeps the user's value.
    runtime.dispatch("inc");
    expect(runtime.snapshot().node).toMatchObject({ children: [{ text: "Count: 7" }, {}, {}] });
  });

  it("keeps action ids and snapshot identity stable", () => {
    const runtime = createOpenUIRuntime(CALCULATOR);
    const first = runtime.snapshot();
    expect(runtime.snapshot()).toBe(first);
    const ids = actionIds(first.node);
    expect(ids).toEqual(["k7", "k8", "k9", "kdiv", "k4", "k5", "k6", "kmul", "k1", "k2", "k3", "ksub", "k0", "kdot", "keq", "kadd", "clear"]);
    let calls = 0;
    const unsubscribe = runtime.subscribe(() => calls++);
    press(runtime, "5");
    expect(calls).toBe(1);
    const second = runtime.snapshot();
    expect(second).not.toBe(first);
    expect(actionIds(second.node)).toEqual(ids);
    runtime.update(CALCULATOR);
    expect(runtime.snapshot()).toBe(second);
    unsubscribe();
    press(runtime, "5");
    expect(calls).toBe(1);
    expect(runtime.dispatch("missing")).toEqual({});
  });

  it("gives inline buttons path ids, unique per occurrence", () => {
    const runtime = createOpenUIRuntime('root = Stack([b, b, Button("x", @Set($n, 1))])\nb = Button("b", @Set($n, 2))');
    expect(actionIds(runtime.snapshot().node)).toEqual(["b", "b#2", "root/children/2"]);
  });

  it("returns external steps after running the local ones", () => {
    const runtime = createOpenUIRuntime(`root = Stack([go, open, ask])
$n = 0
go = Button("Go", Action([@Set($n, $n + 1), @ToAssistant("Count is " + $n), @OpenUrl("https://example.com/" + $n)]))
open = Button("Open", @OpenUrl("https://example.com"))
ask = Button("Ask", @ToAssistant("why " + $n + "?"))`);
    expect(runtime.dispatch("go")).toEqual({ reply: "Count is 1", url: "https://example.com/1" });
    expect(runtime.snapshot().node).toMatchObject({
      children: [{ action: "go" }, { url: "https://example.com" }, { reply: "why 1?" }],
    });
  });

  it("binds an Input to a $variable", () => {
    const runtime = createOpenUIRuntime(`root = Stack([field, Text("Hi " + $name)])
$name = "you"
field = Input("Name", "Ask", "Tell me about {value}", false, $name)`);
    expect(runtime.snapshot().node).toMatchObject({ children: [{ bind: "field", value: "you" }, { text: "Hi you" }] });
    runtime.setInput("field", "Ada");
    expect(runtime.snapshot().node).toMatchObject({ children: [{ bind: "field", value: "Ada" }, { text: "Hi Ada" }] });
    const submit = createOpenUIRuntime(
      'root = Stack([Input("x", null, null, null, $q), Button("Go", Action([@Set($last, $value), @Reset($q)])), Text("Last: " + $last)])\n$q = "draft"\n$last = "none"',
    );
    expect(submit.snapshot().node).toMatchObject({ children: [{ value: "draft" }, {}, { text: "Last: none" }] });
    submit.setInput("root/children/0", "typed");
    expect(submit.dispatch("root/children/1", { value: "typed" })).toEqual({});
    expect(submit.snapshot().node).toMatchObject({ children: [{ value: "draft" }, {}, { text: "Last: typed" }] });
  });

  it("parseOpenUI evaluates stateful buttons to action ids", () => {
    expect(parseOpenUI('root = Button("+", @Set($n, $n + 1))').node).toEqual({
      widget: "button",
      label: "+",
      action: "root",
      variant: "secondary",
    });
  });
});

describe("runtime-only widget fields", () => {
  it("are dropped from static ```ui JSON", () => {
    expect(parseWidget('{"widget":"button","label":"x","action":"a"}')).toBeNull();
    expect(parseWidget('{"widget":"button","label":"x","reply":"y","action":"a"}')).toEqual({
      widget: "button",
      label: "x",
      reply: "y",
      variant: "secondary",
    });
    expect(parseWidget('{"widget":"input","bind":"b","value":"v"}')).toEqual({ widget: "input", button: "Send", reply: "{value}" });
    expect(parseWidget('{"widget":"stat","label":"l","value":"v"}')).toMatchObject({ value: "v" });
  });
});

describe("vendored lang-core", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
  const openui = join(import.meta.dirname, "../src/openui");
  const runtimeFiles = [...files(join(openui, "lang")), join(openui, "parse.ts"), join(openui, "runtime.ts")];

  it("never evaluates code", () => {
    expect(runtimeFiles.length).toBeGreaterThan(10);
    for (const file of runtimeFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/(?<![\w.])eval\s*\(|\bnew\s+Function\b|(?<![\w.])Function\s*\(/);
    }
  });

  it("imports no Node or DOM APIs", () => {
    for (const file of runtimeFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from\s+["'](?:node:|fs|path|process)|\b(?:window|document|process)\.\w/);
    }
  });
});
