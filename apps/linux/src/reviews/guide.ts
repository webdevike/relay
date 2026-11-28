// The Reviews Guide (evaos-electron guide.ts): a reviewer's walkthrough of a PR, written by Claude
// headless (`claude -p`, no tools, no session) from the PR's title, body and annotated diff. The
// prompt and the check of the answer are `@relay/protocol/review-guide`, shared with Relay
// Desktop's local runner; when the model fails the files are grouped by folder instead. Kept per
// PR head commit in `$XDG_CONFIG_HOME/relay/reviews/guides.json`, so a PR is written once per push.

import { tmpdir } from "node:os";
import { ReviewGuide } from "@relay/protocol";
import { folderSections, guidePrompt, parseGuide, sendDiff, type GuideInput } from "@relay/protocol/review-guide";
import { z } from "zod";
import { readJson, writeJson, type ToolRun } from "./exec";

const GUIDE_TIMEOUT_MS = 180_000;
const KEEP_GUIDES = 40;
/** Cache generation: v1 entries (folder-level sections) are not served to a v2 reader. */
const CACHE_VERSION = "v2";
export const HEAD_CHANGED = "PR changed; regenerating";

const ClaudeOut = z.object({ result: z.string(), is_error: z.boolean().optional() });
const Saved = z.record(z.string(), ReviewGuide.extend({ at: z.number() }));

/** What the Guide is written from, read for one head commit. */
export type GuideSnapshot = GuideInput & { headRefOid: string };

/** Runs the prompt once and answers the model's text; throws with a short reason. */
export type GuideWriter = (prompt: string) => Promise<string>;

/** `claude -p` on Sonnet with no tools, no MCP servers, no settings and no saved session. */
export function claudeWriter(run: ToolRun, claude: string): GuideWriter {
  return async (prompt) => {
    const res = await run(
      [claude, "-p", prompt, "--model", "sonnet", "--tools", "", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", ""],
      { cwd: tmpdir(), timeoutMs: GUIDE_TIMEOUT_MS },
    );
    if (res.timedOut) throw new Error("Claude took too long");
    if (res.code !== 0) throw new Error(`claude exited ${res.code === null ? "by a signal" : String(res.code)}`);
    let json: unknown;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      throw new Error("Claude returned no answer");
    }
    const out = ClaudeOut.safeParse(json);
    if (!out.success || out.data.is_error === true) throw new Error("Claude returned no answer");
    return out.data.result;
  };
}

/** The Guide for `headSha`; rejects with HEAD_CHANGED when the snapshot read is for another head. */
export type GuideRead = (key: string, headSha: string, pr: GuideSnapshot) => Promise<ReviewGuide>;

/** Writes one Guide: the model's walkthrough, or the folder fallback with the reason. */
async function writeGuide(write: GuideWriter, headSha: string, pr: GuideInput): Promise<ReviewGuide> {
  const paths = pr.files.map((f) => f.path);
  try {
    const sent = sendDiff(pr.diff);
    const body = parseGuide(await write(guidePrompt(pr, sent)), sent, paths);
    if (!body) throw new Error("Claude answered in the wrong shape");
    return { headSha, source: "model", error: null, ...body };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { headSha, source: "folders", error, sections: folderSections(paths) };
  }
}

/** One Guide per PR head, kept in `file`; one generation at a time per head. */
export function guideCache(file: string, write: GuideWriter): GuideRead {
  const running = new Map<string, Promise<ReviewGuide>>();
  const saved = (): z.infer<typeof Saved> => {
    const all = Saved.safeParse(readJson(file, {}));
    return all.success ? all.data : {};
  };
  const keep = (id: string, guide: ReviewGuide): void => {
    const kept = Object.entries({ ...saved(), [id]: { ...guide, at: Date.now() } })
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, KEEP_GUIDES);
    writeJson(file, Object.fromEntries(kept));
  };
  return (key, headSha, pr) => {
    if (pr.headRefOid !== headSha) return Promise.reject(new Error(HEAD_CHANGED));
    const id = `${key}@${headSha}@${CACHE_VERSION}`;
    const hit = saved()[id];
    if (hit) return Promise.resolve(ReviewGuide.parse(hit));
    const busy = running.get(id);
    if (busy) return busy;
    const job = writeGuide(write, headSha, pr)
      .then((guide) => {
        // Only a written Guide is kept; after a fallback the next open asks the model again.
        if (guide.source === "model") keep(id, guide);
        return guide;
      })
      .finally(() => running.delete(id));
    running.set(id, job);
    return job;
  };
}
