import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientMessage, ServerMessage } from "@relay/protocol";
import { assistantFilePath, handleAssistantFile } from "../src/assistant/files";
import { REGISTRY_FILE } from "../src/assistant/registry";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An agent home with Nova and Astra; `eva` adds Eva's `work/eva/agents/` (else threads live in `work/agents/`). */
function home(eva: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-files-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".omp", "assistant", "agents", "nova"), { recursive: true });
  writeFileSync(join(dir, REGISTRY_FILE), JSON.stringify({ agents: [{ id: "nova", title: "Nova", avatar: "n" }, { id: "astra", title: "Astra", avatar: "a" }] }));
  writeFileSync(join(dir, ".omp", "assistant", "agents", "nova", "prime.md"), "You are Nova.\n");
  const threads = eva ? join(dir, "work", "eva", "agents", "nova") : join(dir, "work", "agents", "nova");
  mkdirSync(threads, { recursive: true });
  writeFileSync(join(threads, "thread.md"), "# Thread\n");
  return dir;
}

const req = (op: "read" | "version" | "save", file: "prime" | "thread" = "prime", extra: object = {}) => ({ agent: "nova", file, op, ...extra });

describe("assistantFilePath", () => {
  it("resolves prime and thread against the home's layout", () => {
    expect(assistantFilePath(home(true), "nova", "prime")).toBe(".omp/assistant/agents/nova/prime.md");
    expect(assistantFilePath(home(true), "nova", "thread")).toBe("work/eva/agents/nova/thread.md");
    expect(assistantFilePath(home(false), "nova", "thread")).toBe("work/agents/nova/thread.md");
  });
});

describe("handleAssistantFile", () => {
  it("reads prime.md and thread.md with a version", () => {
    for (const eva of [true, false]) {
      const dir = home(eva);
      const prime = handleAssistantFile(dir, req("read"));
      expect(prime).toMatchObject({ ok: true, kind: "text", text: "You are Nova.\n", version: { size: 14 } });
      expect(handleAssistantFile(dir, req("read", "thread"))).toMatchObject({ ok: true, kind: "text", text: "# Thread\n" });
      const v = handleAssistantFile(dir, req("version"));
      expect(v.version?.hash).toBe(prime.version?.hash);
      expect(v.text).toBeUndefined();
    }
  });

  it("saves atomically when the version matches, and leaves no temp file", () => {
    const dir = home(true);
    const hash = handleAssistantFile(dir, req("read")).version?.hash;
    const saved = handleAssistantFile(dir, req("save", "prime", { text: "You are Nova, shorter.\n", expectedHash: hash }));
    expect(saved.ok).toBe(true);
    const file = join(dir, ".omp/assistant/agents/nova/prime.md");
    expect(readFileSync(file, "utf8")).toBe("You are Nova, shorter.\n");
    expect(saved.version?.hash).toBe(handleAssistantFile(dir, req("version")).version?.hash);
    expect(readdirSync(join(dir, ".omp/assistant/agents/nova"))).toEqual(["prime.md"]);
  });

  it("refuses a save over a changed file unless forced", () => {
    const dir = home(true);
    const hash = handleAssistantFile(dir, req("read")).version?.hash;
    writeFileSync(join(dir, ".omp/assistant/agents/nova/prime.md"), "edited on the host\n");
    const refused = handleAssistantFile(dir, req("save", "prime", { text: "mine", expectedHash: hash }));
    expect(refused).toMatchObject({ ok: false, code: "changed-on-disk" });
    expect(readFileSync(join(dir, ".omp/assistant/agents/nova/prime.md"), "utf8")).toBe("edited on the host\n");
    expect(handleAssistantFile(dir, req("save", "prime", { text: "mine", expectedHash: null })).code).toBe("changed-on-disk");
    expect(handleAssistantFile(dir, req("save", "prime", { text: "mine", expectedHash: null, force: true })).ok).toBe(true);
    expect(readFileSync(join(dir, ".omp/assistant/agents/nova/prime.md"), "utf8")).toBe("mine");
  });

  it("only serves agents in the registry, and never creates files", () => {
    const dir = home(true);
    expect(handleAssistantFile(dir, { ...req("read"), agent: "ghost" })).toMatchObject({ ok: false, code: "unknown-agent" });
    // Astra is listed but has no prime: not found, and a save does not create it.
    const astra = { ...req("save", "prime", { text: "x", force: true }), agent: "astra" };
    expect(handleAssistantFile(dir, astra)).toMatchObject({ ok: false, code: "not-found" });
    expect(existsSync(join(dir, ".omp/assistant/agents/astra"))).toBe(false);
  });

  it("rejects a prime that is a symlink out of the home", () => {
    const dir = home(true);
    const outside = mkdtempSync(join(tmpdir(), "relay-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.md"), "secret");
    const file = join(dir, ".omp/assistant/agents/nova/prime.md");
    rmSync(file);
    symlinkSync(join(outside, "secret.md"), file);
    expect(handleAssistantFile(dir, req("read"))).toMatchObject({ ok: false, code: "invalid" });
    expect(handleAssistantFile(dir, req("save", "prime", { text: "x", force: true }))).toMatchObject({ ok: false, code: "invalid" });
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("secret");
  });

  it("answers a home without a registry as an unknown agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-empty-"));
    dirs.push(dir);
    expect(handleAssistantFile(dir, req("read")).code).toBe("unknown-agent");
  });
});

describe("the wire frames", () => {
  it("parse as the desktop sends them and as the host answers", () => {
    const dir = home(true);
    const sent = { t: "assistant.file.req", rid: "relay-desktop-files-x-1", agent: "nova", file: "prime", op: "save", text: "x", expectedHash: null, force: false };
    const parsed = ClientMessage.parse(sent);
    if (parsed.t !== "assistant.file.req") throw new Error("wrong frame");
    expect(handleAssistantFile(dir, parsed)).toMatchObject({ ok: false, code: "changed-on-disk" });
    const readReq = ClientMessage.parse({ ...sent, op: "read" });
    if (readReq.t !== "assistant.file.req") throw new Error("wrong frame");
    const frame = ServerMessage.parse({ t: "assistant.file.res", rid: sent.rid, ...handleAssistantFile(dir, readReq) });
    expect(frame).toMatchObject({ t: "assistant.file.res", ok: true, kind: "text", text: "You are Nova.\n", path: expect.stringContaining("prime.md") as string });
    // A path in the frame is not a field the host reads, and a bad agent id or file name does not parse.
    expect(() => ClientMessage.parse({ ...sent, agent: "../nova" })).toThrow();
    expect(() => ClientMessage.parse({ ...sent, file: "agents.json" })).toThrow();
  });
});
