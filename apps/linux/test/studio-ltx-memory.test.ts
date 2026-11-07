import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StudioSpec } from "@relay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { LtxRunner } from "../src/studio/ltx";
import { LaunchdLtxMemory, type LtxMemory, QWEN_LABEL } from "../src/studio/ltx-memory";
import type { StudioRunInput } from "../src/studio/runner";
import { flush, ltxSpec, studioHarness } from "./studio-fakes";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-ltx-memory-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function input(spec: StudioSpec): StudioRunInput {
  return { spec, frames: {}, refs: [], workDir: freshDir(), signal: new AbortController().signal, note: () => undefined, blocked: () => undefined };
}

/** A fake venv python that logs what it saw to `events` and writes the --out clip, or exits 1. */
function fakeLtx(events: string, fail = false): string {
  const dir = freshDir();
  mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
  writeFileSync(join(dir, "draft.py"), "");
  const python = join(dir, ".venv", "bin", "python");
  writeFileSync(
    python,
    `#!/bin/sh\necho "run lock=$EVA_GPU_LOCK" >> "${events}"\n${fail ? "echo boom >&2\nexit 1\n" : 'while [ $# -gt 0 ]; do\n  if [ "$1" = "--out" ]; then echo clip > "$2"; fi\n  shift\ndone\n'}`,
  );
  chmodSync(python, 0o755);
  return dir;
}

function recordingMemory(log: string[]): LtxMemory {
  return {
    prepare: () => {
      log.push("prepare");
      return Promise.resolve();
    },
    restore: () => {
      log.push("restore");
      return Promise.resolve();
    },
  };
}

describe("LTX memory around a run", () => {
  it("unloads ComfyUI and stops Qwen before draft.py starts, restores Qwen after it ends, and gives draft.py a lock file of its own", async () => {
    const events = join(freshDir(), "events");
    const order: string[] = [];
    const memory = recordingMemory(order);
    const job = input(ltxSpec());
    const runner = new LtxRunner(fakeLtx(events), undefined, memory);
    await runner.run(job);
    expect(order).toEqual(["prepare", "restore"]);
    // The unload came first: the stand-in python only runs between the two.
    const seen = readFileSync(events, "utf8").trim();
    expect(seen).toBe(`run lock=${join(job.workDir, "draft-gpu.lock")}`);
  });

  it("restores Qwen when the run fails or is cancelled, and a failing restore never fails a finished job", async () => {
    const events = join(freshDir(), "events");
    const order: string[] = [];
    await expect(new LtxRunner(fakeLtx(events, true), undefined, recordingMemory(order)).run(input(ltxSpec()))).rejects.toThrow("boom");
    expect(order).toEqual(["prepare", "restore"]);

    const controller = new AbortController();
    controller.abort();
    const cancelled: string[] = [];
    await expect(new LtxRunner(fakeLtx(events), undefined, recordingMemory(cancelled)).run({ ...input(ltxSpec()), signal: controller.signal })).rejects.toThrow("Cancelled");
    expect(cancelled).toEqual(["prepare", "restore"]);
  });
});

describe("LaunchdLtxMemory", () => {
  function setup(plistExists: boolean, failing: readonly string[] = []) {
    const calls: string[] = [];
    const freed: string[] = [];
    const plist = join(freshDir(), `${QWEN_LABEL}.plist`);
    if (plistExists) writeFileSync(plist, "<plist/>");
    const memory = new LaunchdLtxMemory({
      freeComfy: [
        () => {
          freed.push("image");
          return Promise.resolve();
        },
        () => {
          freed.push("video");
          return Promise.resolve();
        },
      ],
      launchctl: (args) => {
        calls.push(args.join(" "));
        return failing.includes(args[0] ?? "") ? Promise.reject(new Error("exit 113")) : Promise.resolve();
      },
      uid: 501,
      qwenPlist: plist,
      log: () => undefined,
    });
    return { memory, calls, freed, plist };
  }

  it("frees both ComfyUI servers and boots Qwen out of gui/501, then bootstraps its plist back", async () => {
    const { memory, calls, freed, plist } = setup(true);
    await memory.prepare();
    expect(freed).toEqual(["image", "video"]);
    expect(calls).toEqual([`bootout gui/501/${QWEN_LABEL}`]);
    await memory.restore();
    expect(calls).toEqual([`bootout gui/501/${QWEN_LABEL}`, `bootstrap gui/501 ${plist}`]);
  });

  it("tolerates Qwen already being stopped (memwatch got there first) or already running, and leaves it alone without its plist", async () => {
    const stopped = setup(true, ["bootout", "bootstrap"]);
    await stopped.memory.prepare();
    await stopped.memory.restore();
    expect(stopped.calls).toHaveLength(2);

    const absent = setup(false);
    await absent.memory.prepare();
    await absent.memory.restore();
    expect(absent.freed).toEqual(["image", "video"]);
    expect(absent.calls).toEqual([]);
  });
});

describe("LTX under the host GPU lock", () => {
  it("is queued behind the lock holder: nothing starts while another GPU job has the lock", async () => {
    const h = studioHarness(freshDir());
    h.lock.holdElsewhere();
    // The fake runner stands in for LtxRunner: it only starts once the service holds the lock.
    await h.service.handle({ kind: "create", spec: ltxSpec(), origin: "desktop" });
    await flush();
    expect(h.runners.ltx.runs).toEqual([]);
    h.lock.freeElsewhere();
    await flush();
    expect(h.runners.ltx.runs).toHaveLength(1);
    expect(h.lock.granted).toEqual([expect.stringContaining("(relay studio ltx)")]);
  });
});
