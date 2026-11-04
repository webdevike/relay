// An assistant's two instruction files for a desktop that has no copy of them (`assistant.file.req`):
// `prime.md` (`primeFile`) and the thread memory (`threadFile`). The request names an agent from the
// registry and one of those two files, never a path, so nothing else under the agent home is reachable.
// Saves are whole-file (tmp + rename) like the registry's, and refuse when the file changed since the
// client read it.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { AssistantFileReq, AssistantFileRes } from "@relay/protocol";
import { threadFile } from "./admin";
import { loadRegistry } from "./registry";
import { primeFile } from "./service";

/** Files larger than this are not sent (a prime or thread memory is a few KB). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const sha1 = (buf: Buffer): string => createHash("sha1").update(buf).digest("hex");

type Result = Omit<AssistantFileRes, "t" | "rid">;

const fail = (code: NonNullable<AssistantFileRes["code"]>, error: string): Result => ({ ok: false, code, error });

/** The path (relative to the agent home) of `file` for agent `id`; the same rule the host reads and scaffolds with. */
export function assistantFilePath(agentHome: string, id: string, file: AssistantFileReq["file"]): string {
  return file === "prime" ? primeFile(id) : threadFile(agentHome, id);
}

/** Answers one `assistant.file.req` against `agentHome`. Never throws. */
export function handleAssistantFile(agentHome: string, req: Pick<AssistantFileReq, "agent" | "file" | "op" | "text" | "expectedHash" | "force">): Result {
  try {
    let known: boolean;
    try {
      known = loadRegistry(agentHome).some((agent) => agent.id === req.agent);
    } catch {
      known = false;
    }
    if (!known) return fail("unknown-agent", `${req.agent} is not an assistant on this host.`);
    const home = realpathSync(agentHome);
    const abs = join(home, assistantFilePath(agentHome, req.agent, req.file));
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return fail("not-found", `${basename(abs)} does not exist yet.`);
    }
    // A symlink that leaves the agent home is not this assistant's file.
    if (!real.startsWith(home + sep)) return fail("invalid", `${basename(abs)} is outside the agent home.`);
    const st = statSync(real);
    if (!st.isFile()) return fail("not-found", `${basename(abs)} is not a file.`);
    if (req.op === "save") return save(real, st.mode & 0o7777, req);
    if (st.size > MAX_FILE_BYTES) return { ok: true, kind: "too-large", path: real, version: { mtimeMs: st.mtimeMs, size: st.size, hash: "" } };
    const buf = readFileSync(real);
    const version = { mtimeMs: st.mtimeMs, size: buf.length, hash: sha1(buf) };
    if (req.op === "version") return { ok: true, path: real, version };
    // A NUL byte early on, or invalid UTF-8, is not text the editor can open.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      return { ok: true, kind: "binary", path: real, version };
    }
    if (text.slice(0, 8000).includes("\0")) return { ok: true, kind: "binary", path: real, version };
    return { ok: true, kind: "text", text, path: real, version };
  } catch (error) {
    return fail("internal", error instanceof Error ? error.message : String(error));
  }
}

function save(real: string, mode: number, req: Pick<AssistantFileReq, "text" | "expectedHash" | "force">): Result {
  if (req.text === undefined) return fail("invalid", "save needs text.");
  if (req.force !== true) {
    const disk = readFileSync(real);
    if (req.expectedHash === undefined || req.expectedHash === null || sha1(disk) !== req.expectedHash) {
      return fail("changed-on-disk", "The file changed on the host. Your edits are kept.");
    }
  }
  const data = Buffer.from(req.text, "utf8");
  const temp = join(dirname(real), `.${basename(real)}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(temp, "wx", mode);
    try {
      writeSync(fd, data);
      chmodSync(temp, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, real);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  const after = statSync(real);
  return { ok: true, path: real, version: { mtimeMs: after.mtimeMs, size: data.length, hash: sha1(data) } };
}
