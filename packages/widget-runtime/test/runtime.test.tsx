// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as MantineCore from "@mantine/core";
import { compileWidget, widgetFactorySource } from "../src/runtime/compile";
import { WidgetRoot } from "../src/runtime/index";
import { defaultConfig } from "../src/theme";

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const noop = (): undefined => undefined;
  // jsdom has neither; Mantine reads the scheme query and Recharts observes its container.
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: noop,
      removeEventListener: noop,
    }) as unknown as MediaQueryList;
  window.ResizeObserver = class {
    observe = noop;
    unobserve = noop;
    disconnect = noop;
  };
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function render(source: string, colorScheme: "light" | "dark" = "light"): Promise<string> {
  const element = document.createElement("div");
  document.body.append(element);
  // React logs caught render errors; the Alert is what matters here.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const root = createRoot(element);
  await act(() => {
    root.render(<WidgetRoot source={source} config={defaultConfig} colorScheme={colorScheme} />);
    return Promise.resolve();
  });
  return element.innerHTML;
}

describe("widgetFactorySource", () => {
  it("wraps a lone element, a component body, and an exported component", () => {
    expect(widgetFactorySource("<Button/>")).toContain("return (<Button/>);");
    expect(widgetFactorySource("const [n] = useState(1);\nreturn <Text>{n}</Text>;")).toContain(
      "return function Widget() {\nconst [n] = useState(1);",
    );
    expect(widgetFactorySource("export default function Card2() { return <Card/> }")).toContain(
      "return function Card2()",
    );
  });

  it("drops import lines", () => {
    const source =
      "import { Button } from \"@mantine/core\";\nimport React from 'react'\n<Button/>";
    expect(widgetFactorySource(source)).not.toContain("import");
  });
});

describe("compileWidget", () => {
  it("evaluates TSX with the scope's names", () => {
    const Widget = compileWidget("const label: string = 'Go';\nreturn <Button>{label}</Button>;", {
      ...MantineCore,
      React: {
        createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
          type,
          props,
          children,
        }),
      },
    });
    expect(Widget({})).toMatchObject({ type: MantineCore.Button, children: ["Go"] });
  });

  it("throws on code that does not parse", () => {
    expect(() => compileWidget("return <Button>", {})).toThrow();
  });
});

describe("WidgetRoot", () => {
  it("renders Mantine, charts and hooks from the agent's JSX", async () => {
    const html = await render(`
const [mode, setMode] = useState("week");
const data = [{ day: "Mon", runs: 3 }, { day: "Tue", runs: 5 }];
return (
  <Card withBorder>
    <SegmentedControl value={mode} onChange={setMode} data={["week", "month"]} />
    <TextInput label="Note" />
    <BarChart h={120} data={data} dataKey="day" series={[{ name: "runs", color: "blue.6" }]} />
    <Button onClick={() => relay.reply(mode)}>Send {mode}</Button>
  </Card>
);`);
    expect(html).toContain("Send week");
    expect(html).toContain("mantine-SegmentedControl-root");
    expect(html).toContain("mantine-TextInput-root");
    expect(html).toContain("mantine-BarChart-root");
    expect(html).toContain("eva-theme-card");
  });

  it("shows a compile error as an Alert", async () => {
    const html = await render("return <Button>", "dark");
    expect(html).toContain("Widget error");
    expect(html).toContain("mantine-Alert-root");
  });

  it("shows a render error as an Alert", async () => {
    const html = await render("throw new Error('boom');");
    expect(html).toContain("Widget error");
    expect(html).toContain("boom");
  });
});
