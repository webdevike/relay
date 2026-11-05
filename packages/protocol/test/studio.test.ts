import { describe, expect, it } from "vitest";
import { parseServerMessage } from "../src/index";

// A newer host can list a backend this phone build has never heard of (ComfyUI presets reached older
// phones that way). The phone keeps the rest of Studio instead of dropping the whole `studio.state`.

const backend = (id: string) => ({
  id,
  label: id,
  mode: "image",
  paid: false,
  available: true,
  resolutions: [{ id: "1024x1024", label: "1024", aspect: "1:1" }],
  seconds: [],
  frames: [],
  refs: 0,
  seed: false,
  serial: false,
});

const job = (id: string, backendId: string) => ({
  id,
  spec: { mode: "image", backend: backendId, prompt: "a cat", aspect: "1:1", resolution: "1024x1024" },
  state: "done",
  origin: "phone",
  createdAt: 1,
  progress: 1,
  outputs: [],
});

const state = (jobs: unknown[], backends: unknown[]) =>
  JSON.stringify({ t: "studio.state", jobs, uploads: [], backends });

describe("studio.state from a newer host", () => {
  it("drops the backends and jobs this build does not know and keeps the rest", () => {
    const parsed = parseServerMessage(
      state([job("j1", "future-backend"), job("j2", "codex-image")], [backend("future-backend"), backend("codex-image")]),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    if (parsed.value.t !== "studio.state") throw new Error(parsed.value.t);
    expect(parsed.value.backends.map((b) => b.id)).toEqual(["codex-image"]);
    expect(parsed.value.jobs.map((j) => j.id)).toEqual(["j2"]);
  });

  it("still rejects a malformed entry on a known backend", () => {
    const broken = { ...backend("codex-image"), refs: -1 };
    expect(parseServerMessage(state([], [broken])).ok).toBe(false);
    expect(parseServerMessage(state([{ ...job("j1", "codex-image"), progress: 2 }], [])).ok).toBe(false);
  });
});
