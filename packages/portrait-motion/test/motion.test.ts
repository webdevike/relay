import { describe, expect, it } from "vitest";
import {
  Director,
  IDLE_SIGNALS,
  SNOOZE_MS,
  STATE_IDS,
  STATE_META,
  Timeline,
  apply,
  bbox,
  buildRig,
  extension,
  micahCredit,
  chain,
  frame,
  geometry,
  invert,
  parseTransform,
  partSvg,
  restingSvg,
  rotate,
  translate,
  type MotionSignals,
  statusDot,
  toolKind,
  type Portrait,
} from "../src/index";
import { eyeBoxes, polylines } from "../src/extend";

const NOVA: Portrait = {
  style: "micah",
  seed: "nova-17",
  options: {
    base: ["standard"],
    earringsProbability: 0,
    ears: ["attached"],
    eyebrows: ["eyelashesDown"],
    eyes: ["eyes"],
    facialHairProbability: 0,
    glasses: ["round"],
    glassesProbability: 100,
    hair: ["full"],
    hairProbability: 100,
    mouth: ["smile"],
    nose: ["curve"],
    shirt: ["crew"],
    baseColor: ["b16a5b"],
    hairColor: ["e0ddff"],
    shirtColor: ["000000"],
    earrings: ["stud"],
  },
  colors: { paper: "#e7f5ff", accent: "#f76707" },
};
const ASTRA: Portrait = {
  style: "notionists",
  seed: "astra-2",
  options: {
    base: ["variant01"],
    beardProbability: 0,
    body: ["variant18"],
    bodyIcon: ["electric"],
    bodyIconProbability: 100,
    brows: ["variant05"],
    eyes: ["variant02"],
    gestureProbability: 0,
    glasses: ["variant03"],
    glassesProbability: 100,
    hair: ["variant57"],
    lips: ["variant20"],
    nose: ["variant01"],
  },
  colors: { paper: "#e7f5ff", accent: "#1c7ed6" },
};
const POLARIS: Portrait = { style: "notionists", seed: "polaris-11" };

/** The art of a resting frame's layers; brows are split into near and far, so they are left out. */
const arts = (p: Portrait): string[] => {
  const rig = buildRig(p);
  return frame(rig, new Timeline("idle", 0).clip(0), 100)
    .layers.filter((l) => !/^(near|far):/.test(l.part))
    .map((l) => rig.parts[l.part] ?? "");
};

describe("affine", () => {
  it("parses SVG transforms and inverts them", () => {
    const m = parseTransform("translate(10 20) rotate(30 5 5) scale(2)");
    const [x, y] = apply(chain(m, invert(m)), 3, 4);
    expect(x).toBeCloseTo(3);
    expect(y).toBeCloseTo(4);
    expect(apply(rotate(90), 1, 0)[1]).toBeCloseTo(1);
    expect(apply(translate(1, 2), 0, 0)).toEqual([1, 2]);
  });
});

describe("bbox", () => {
  it("bounds relative paths, arcs and ellipses", () => {
    expect(bbox('<path d="M10 10h20v5a2 2 0 0 1-4 0Z"/>')).toEqual({
      x0: 10,
      y0: 10,
      x1: 30,
      y1: 15,
    });
    expect(bbox('<ellipse cx="5" cy="6" rx="2" ry="3"/>')).toEqual({ x0: 3, y0: 3, x1: 7, y1: 9 });
    expect(bbox("<g></g>")).toBeNull();
  });
});

describe("buildRig", () => {
  it.each([
    ["Nova (micah, designed)", NOVA],
    ["Astra (notionists, designed)", ASTRA],
    ["Polaris (notionists, seed)", POLARIS],
  ])("rests on exactly the parts %s draws statically", (_name, p) => {
    const resting = restingSvg(p);
    for (const art of arts(p)) {
      const inner = art.replace(/^<g transform="[^"]*">/, "").replace(/<\/g>$/, "");
      // Merged layers hold several groups; each must be the static portrait's own markup.
      for (const piece of inner.split(/(?=<g transform=)/))
        expect(resting).toContain(piece.replace(/<\/g>$/, ""));
    }
  });

  it("keeps a designed portrait's explicit parts, not the seed's", () => {
    const rig = buildRig(ASTRA);
    const seeded = buildRig({ style: "notionists", seed: "astra-2" });
    expect(rig.expr.brows["rest"]).toBe("variant05");
    expect(rig.expr.mouth["rest"]).toBe("variant20");
    expect(rig.expr.eyes["rest"]).toBe("variant02");
    expect(arts(ASTRA).join("")).not.toBe(arts({ style: "notionists", seed: "astra-2" }).join(""));
    expect(seeded).not.toBe(rig);
    expect(buildRig({ ...ASTRA })).toBe(rig);
  });

  it("draws every part a state can pick, as standalone SVG documents", () => {
    for (const p of [NOVA, ASTRA, POLARIS]) {
      const rig = buildRig(p);
      for (const state of STATE_IDS)
        for (const t of [0, 300, 1100, 2500, 3500]) {
          const f = frame(rig, new Timeline(state, 0).clip(t), 64);
          expect(f.layers.length).toBeGreaterThan(5);
          for (const l of f.layers) {
            expect(rig.parts[l.part], `${p.seed} ${state} ${l.part}`).toBeDefined();
            expect(l.m.every(Number.isFinite)).toBe(true);
          }
        }
      const svg = partSvg(rig, rig.layers.find((l) => l.part !== undefined)?.part ?? "");
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg).toContain(`viewBox="0 0 ${rig.size} ${rig.size}"`);
    }
  });
});

describe("frame", () => {
  const rig = buildRig(ASTRA);
  const at = (state: (typeof STATE_IDS)[number], ms: number) =>
    frame(rig, new Timeline(state, 0).clip(ms), 84);

  it("shows each state's overlays", () => {
    expect(Math.max(...at("thinking", 1500).fx.dots)).toBeGreaterThan(0.5);
    expect(Math.max(...at("idle", 1500).fx.dots)).toBe(0);
    expect(Math.max(...at("listening", 1500).fx.waves.map((w) => w.o))).toBeGreaterThan(0);
    expect(at("confused", 1500).fx.quiz.o).toBe(1);
    expect(at("error", 1500).fx.drop.o).toBeGreaterThan(0);
    expect(at("done", 600).fx.confetti.length).toBeGreaterThan(0);
    expect(at("researching", 1500).fx.lens.o).toBe(1);
    expect(at("idle", 1500).fx.lens.o).toBe(0);
    expect(Math.max(...at("snoozing", 2000).fx.zs.map((z) => z.o))).toBeGreaterThan(0);
    expect(geometry(84).dots).toHaveLength(14);
  });

  it("raises a gesture and swaps mouths", () => {
    expect(at("working", 1500).layers.some((l) => l.part === "gesture:handPhone")).toBe(true);
    expect(at("idle", 1500).layers.some((l) => l.part.startsWith("gesture:"))).toBe(false);
    const mouths = new Set(
      [0, 111, 222, 333, 444, 555].map(
        (ms) => at("talking", ms).layers.find((l) => l.part.startsWith("mouth:"))?.part,
      ),
    );
    expect(mouths.size).toBeGreaterThan(2);
  });

  it("is a pure function of the clip", () => {
    expect(at("hello", 900)).toEqual(at("hello", 900));
  });

  it("blends from the previous state", () => {
    const t = new Timeline("idle", 0);
    t.set("error", 5000);
    expect(t.clip(5100)).toMatchObject({ state: "error", prev: "idle", prevDur: 5, lt: 0.1 });
    const blended = frame(rig, t.clip(5100), 84);
    const settled = frame(rig, t.clip(9000), 84);
    expect(blended.layers[0]?.m).not.toEqual(settled.layers[0]?.m);
  });
});

describe("toolKind", () => {
  it("calls reading, searching and fetching research, everything else work", () => {
    for (const t of [
      "web_search",
      "read",
      "browse",
      "fetch",
      "grep",
      "glob",
      "find",
      "mcp__exa__search",
      "WebFetch",
      "Grep",
    ])
      expect(toolKind(t), t).toBe("research");
    for (const t of ["bash", "edit", "write", "task", "Bash", "ask"])
      expect(toolKind(t), t).toBe("work");
  });
});

describe("Director", () => {
  const sig = (s: Partial<MotionSignals> = {}): MotionSignals => ({
    ...IDLE_SIGNALS,
    activityAt: 0,
    ...s,
  });

  it("plays a scripted turn calmly: idle, thinking, researching, working, thinking while writing, idle", () => {
    const d = new Director();
    expect(d.next(sig(), 0)).toBe("idle");
    expect(d.next(sig({ running: true, activityAt: 1000 }), 1000)).toBe("thinking");
    expect(d.next(sig({ running: true, tool: "research", activityAt: 1000 }), 2000)).toBe(
      "researching",
    );
    expect(d.next(sig({ running: true, tool: "work", activityAt: 1000 }), 3000)).toBe("working");
    expect(d.next(sig({ running: true, activityAt: 4000 }), 4000)).toBe("thinking");
    expect(d.next(sig({ activityAt: 5000 }), 5000)).toBe("idle");
  });

  it("keeps needing Isaac and failing out of the face: idle with an orange or red dot", () => {
    const d = new Director();
    const waiting = sig({ running: true, waiting: true });
    expect(d.next(waiting, 0)).toBe("idle");
    expect(statusDot(waiting)).toBe("orange");
    const failed = sig({ failed: true });
    expect(d.next(failed, 100)).toBe("idle");
    expect(statusDot(failed)).toBe("red");
    expect(statusDot(sig({ running: true }))).toBe("accent");
    expect(statusDot(sig())).toBeNull();
  });

  it("snoozes after 30 quiet minutes and wakes on the next message", () => {
    const d = new Director();
    expect(d.next(sig(), SNOOZE_MS - 1)).toBe("idle");
    expect(d.next(sig(), SNOOZE_MS)).toBe("snoozing");
    const now = SNOOZE_MS + 60_000;
    expect(d.next(sig({ running: true, activityAt: now }), now)).toBe("waking");
    expect(
      d.next(sig({ running: true, activityAt: now }), now + STATE_META.waking.dur * 1000),
    ).toBe("thinking");
  });
});

describe("micahCredit", () => {
  it("names every assistant drawn with Micah", () => {
    expect(micahCredit([{ title: "Astra", style: "notionists" }])).toBeNull();
    expect(micahCredit([{ title: "Nova", style: "micah" }])).toBe(
      "Nova avatar: Micah by Micah Lanier, CC BY 4.0, modified",
    );
    expect(
      micahCredit([
        { title: "Astra", style: "notionists" },
        { title: "Nova", style: "micah" },
        { title: "Polaris", style: "micah" },
      ]),
    ).toBe("Nova and Polaris avatars: Micah by Micah Lanier, CC BY 4.0, modified");
  });
});

describe("Extended mode", () => {
  it("flattens relative curves and arcs", () => {
    const [ring] = polylines("M10 10c0 10 20 10 20 0a10 10 0 0 0-20 0z");
    expect(ring?.closed).toBe(true);
    const ys = (ring?.pts ?? []).filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys)).toBeGreaterThan(14);
    expect(Math.min(...ys)).toBeLessThan(6);
  });

  it("finds one box per eye", () => {
    for (const p of [NOVA, ASTRA, POLARIS]) {
      const rig = buildRig(p);
      expect(eyeBoxes(rig.inner[`eyes:${rig.expr.eyes["rest"] ?? ""}`] ?? ""), p.seed).toHaveLength(
        2,
      );
    }
  });

  it.each([
    ["Nova", NOVA],
    ["Astra", ASTRA],
  ])("morphs %s's mouth into the next instead of swapping it", (_name, p) => {
    const rig = buildRig(p);
    const ext = extension();
    const t = new Timeline("idle", 0);
    frame(rig, t.clip(1000), 84, ext);
    t.set("researching", 1000);
    const mouth = (ms: number) =>
      frame(rig, t.clip(ms), 84, ext).layers.find((l) => l.part.startsWith("mouth:"));
    const mid = mouth(1100);
    expect(mid?.part).toBe(`mouth:${rig.expr.mouth["focus"] as string}`);
    expect(mid?.morph?.length).toBeGreaterThan(0);
    expect(mid?.morph?.every((d) => d.d.startsWith("M") && !d.d.includes("NaN"))).toBe(true);
    expect(mouth(1400)?.morph).toBeUndefined();
  });

  it("closes eyelids over the eyes and rotates the brows", () => {
    for (const p of [NOVA, ASTRA]) {
      const rig = buildRig(p);
      const shut = frame(rig, new Timeline("snoozing", 0).clip(3000), 84, extension());
      const eyes = shut.layers.find((l) => l.part.startsWith("eyes:"));
      expect(eyes?.clip).toHaveLength(2);
      expect(eyes?.clip?.every((b) => b.y1 - b.y0 < 1)).toBe(true);
      expect(eyes?.lids?.[0]?.opacity).toBe(1);
      const open = frame(rig, new Timeline("idle", 0).clip(0), 84, extension()).layers.find((l) =>
        l.part.startsWith("eyes:"),
      );
      expect(open?.clip).toBeUndefined();
      const near = (ext: boolean) =>
        frame(
          rig,
          new Timeline("working", 0).clip(1500),
          84,
          ext ? extension() : undefined,
        ).layers.find((l) => l.part.startsWith("near:"))?.m;
      expect(near(true)).not.toEqual(near(false));
    }
  });
});
