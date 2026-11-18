// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LiveRoot, type RenderReport, type SourceFeed } from "../src/runtime/index";
import { PageStream, type RevealReport } from "../src/runtime/stream";
import { defaultConfig } from "../src/theme";

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const noop = (): undefined => undefined;
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

/** A live page fed by hand: `push` sends a revision, `reports` collects the page's answers. */
async function live(source: string) {
  const element = document.createElement("div");
  document.body.append(element);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  let apply: ((source: string, rev: number, animate?: boolean) => void) | null = null;
  const feed: SourceFeed = {
    listen(fn) {
      apply = fn;
      return () => {
        apply = null;
      };
    },
  };
  const reports: RenderReport[] = [];
  const reveals: (RevealReport & { rev: number })[] = [];
  await act(() => {
    createRoot(element).render(
      <LiveRoot
        source={source}
        config={defaultConfig}
        colorScheme="light"
        system="mantine"
        feed={feed}
        report={(r) => reports.push(r)}
        stream={new PageStream(element)}
        revealed={(rev, r) => reveals.push({ rev, ...r })}
      />,
    );
    return Promise.resolve();
  });
  const push = async (code: string, rev: number, animate = false) => {
    await act(() => {
      apply?.(code, rev, animate);
      return Promise.resolve();
    });
  };
  return { element, reports, reveals, push };
}

describe("LiveRoot", () => {
  it("redraws each revision in place and reports it drawn", async () => {
    const page = await live("<Button>First</Button>");
    expect(page.element.textContent).toContain("First");
    expect(page.reports).toEqual([{ rev: 0, ok: true }]);
    await page.push("<Button>Second</Button>", 1);
    expect(page.element.textContent).toContain("Second");
    expect(page.element.textContent).not.toContain("First");
    expect(page.reports.at(-1)).toEqual({ rev: 1, ok: true });
  });

  it("keeps the last good render when a revision does not compile", async () => {
    const page = await live("<Badge>Good</Badge>");
    await page.push("return <Badge>", 1);
    expect(page.element.textContent).toContain("Good");
    expect(page.element.innerHTML).not.toContain("Widget error");
    expect(page.reports.at(-1)).toMatchObject({ rev: 1, ok: false });
    expect(page.reports.at(-1)?.error).toBeTruthy();
    await page.push("<Badge>Fixed</Badge>", 2);
    expect(page.element.textContent).toContain("Fixed");
    expect(page.reports.at(-1)).toEqual({ rev: 2, ok: true });
  });

  it("keeps the last good render when a revision throws while drawing", async () => {
    const page = await live("<Text>Good</Text>");
    await page.push("throw new Error('boom');", 1);
    expect(page.element.textContent).toContain("Good");
    expect(page.reports.at(-1)).toEqual({ rev: 1, ok: false, error: "boom" });
  });

  it("streams in only what a drawn revision added, never a broken one", async () => {
    const page = await live("<Stack><Title>Assistants</Title></Stack>");
    expect(page.reveals.map((r) => r.rev)).toEqual([0]);
    await page.push("<Stack><Title>Assistants</Title><Text>Who works for you</Text></Stack>", 1);
    expect(page.reveals.at(-1)).toEqual({ rev: 1, units: 1, ms: 0 });
    await page.push("throw new Error('boom');", 2);
    await page.push("return <Stack>", 3);
    expect(page.reveals).toHaveLength(2);
  });

  it("shows the error when no revision has drawn yet", async () => {
    const page = await live("return <Badge>");
    expect(page.element.innerHTML).toContain("Widget error");
    expect(page.reports).toEqual([expect.objectContaining({ rev: 0, ok: false })]);
  });
});
