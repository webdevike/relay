// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PageStream, REVEAL_MS, REVEAL_STEP_MS } from "../src/runtime/stream";

/** Each `animate` call: the element's text (or tag) and its delay. */
let played: { what: string; delay: number }[] = [];

beforeEach(() => {
  played = [];
  Element.prototype.animate = function (
    this: Element,
    _k: unknown,
    o?: number | KeyframeAnimationOptions,
  ) {
    const what = this.textContent.trim() || this.tagName;
    played.push({ what, delay: typeof o === "object" ? Number(o.delay) : 0 });
    return {} as Animation;
  };
});

afterEach(() => {
  document.body.innerHTML = "";
});

const card = (name: string): string =>
  `<div class="card" style="border: 1px solid #ccc"><p>${name}</p><p>Personal</p></div>`;

/** The Assistants page after `step` edits, as a fresh tree (every revision remounts). */
function assistants(step: number, names = ["Nova", "Astra", "Sol", "Penny", "Iris"]): string {
  return `<div class="stack">
    <h2 id="r1">Assistants</h2>
    ${step >= 2 ? '<p class="sub">Who works for you</p>' : ""}
    ${step >= 3 ? `<div class="grid">${names.map(card).join("")}</div>` : ""}
    ${step >= 4 ? "<p>Each assistant keeps its own thread.</p>" : ""}
  </div>`;
}

function page() {
  const root = document.createElement("div");
  document.body.append(root);
  let now = 1_000;
  const stream = new PageStream(root, () => now);
  return {
    stream,
    advance: (ms: number) => (now += ms),
    /** The host posts a revision: the page marks what is on screen, then the new tree draws. */
    draw(html: string, animate = true) {
      stream.mark();
      root.innerHTML = html;
      return stream.reveal(animate);
    },
    first(html: string) {
      root.innerHTML = html;
      return stream.reveal(true);
    },
  };
}

describe("PageStream", () => {
  it("streams a first draw in top to bottom, a grid's cards one by one", () => {
    const p = page();
    const r = p.first(assistants(3));
    expect(played.map((a) => a.what)).toEqual([
      "Assistants",
      "Who works for you",
      "NovaPersonal",
      "AstraPersonal",
      "SolPersonal",
      "PennyPersonal",
      "IrisPersonal",
    ]);
    // Staggered in order from now, the last one in after its own fade.
    expect(played.map((a) => a.delay)).toEqual(played.map((_, i) => i * REVEAL_STEP_MS));
    expect(r).toEqual({ units: 7, ms: 6 * REVEAL_STEP_MS + REVEAL_MS });
  });

  it("an edit streams in only what it added; unchanged elements never animate again", () => {
    const p = page();
    p.first(assistants(1));
    p.advance(5_000);
    played = [];
    expect(p.draw(assistants(2)).units).toBe(1);
    expect(played.map((a) => a.what)).toEqual(["Who works for you"]);
    p.advance(5_000);
    played = [];
    p.draw(assistants(3));
    expect(played).toHaveLength(5);
    expect(played[0]?.what).toBe("NovaPersonal");
    p.advance(5_000);
    played = [];
    p.draw(assistants(4));
    expect(played.map((a) => a.what)).toEqual(["Each assistant keeps its own thread."]);
  });

  it("a changed text inside a card streams in that text alone", () => {
    const p = page();
    p.first(assistants(3));
    p.advance(5_000);
    played = [];
    p.draw(assistants(3, ["Nova", "Astra", "Sol", "Penelope", "Iris"]));
    expect(played.map((a) => a.what)).toEqual(["Penelope"]);
  });

  it("a card inserted at the front arrives alone; the others keep their place", () => {
    const p = page();
    p.first(assistants(3, ["Astra", "Sol"]));
    p.advance(5_000);
    played = [];
    p.draw(assistants(3, ["Nova", "Astra", "Sol"]));
    expect(played.map((a) => a.what)).toEqual(["NovaPersonal"]);
  });

  it("an edit landing mid-reveal merges: arriving elements continue, new ones queue after", () => {
    const p = page();
    p.first(assistants(3));
    // 100 ms in: the title is in its fade, the last card has not started.
    p.advance(100);
    played = [];
    const r = p.draw(assistants(4));
    const delays = Object.fromEntries(played.map((a) => [a.what, a.delay]));
    expect(delays["Assistants"]).toBe(-100);
    expect(delays["IrisPersonal"]).toBe(6 * REVEAL_STEP_MS - 100);
    // The new paragraph queues one step after the last card.
    expect(delays["Each assistant keeps its own thread."]).toBe(7 * REVEAL_STEP_MS - 100);
    expect(r.ms).toBe(7 * REVEAL_STEP_MS - 100 + REVEAL_MS);
  });

  it("a revision that changes nothing visible reveals nothing (React ids differ per mount)", () => {
    const p = page();
    const mount = (rid: string): string =>
      assistants(3)
        .replace('id="r1"', `id="${rid}"`)
        .replace('class="grid"', `class="grid __m__-${rid}"`);
    p.first(mount("_r_8_"));
    p.advance(5_000);
    played = [];
    expect(p.draw(mount("_r_i_"))).toEqual({ units: 0, ms: 0 });
    expect(played).toEqual([]);
  });

  it("a revision that changes nothing visible reveals nothing", () => {
    const p = page();
    p.first(assistants(2));
    p.advance(5_000);
    played = [];
    expect(p.draw(assistants(2).replace('id="r1"', 'id="r9"'))).toEqual({ units: 0, ms: 0 });
    expect(played).toEqual([]);
  });
});
