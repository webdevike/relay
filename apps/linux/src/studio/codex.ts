// Images on Isaac's ChatGPT subscription, the way the Codex CLI asks for them: the access token
// from omp (`omp --profile personal token openai-codex`, never logged), the account id from its
// JWT, and `codex/images/generations` (text) or `codex/images/edits` (reference images as JPEG data
// URLs). The reply is one base64 PNG. Seeds are not a thing there.

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StudioBackend, StudioSpec } from "@relay/protocol";
import { z } from "zod";
import { BACKEND_BASE } from "./backends";
import { oneLine, type StudioRunInput, type StudioRunner, type StudioRunOutput } from "./runner";

export const CODEX_IMAGES_URL = "https://chatgpt.com/backend-api/codex/images";
export const CODEX_IMAGE_MODEL = "gpt-image-2.5-sunburst";
/** How long an omp token is reused before asking omp again (it refreshes expiring ones). */
const TOKEN_REUSE_MS = 5 * 60_000;

/** `fetch` as the runners use it; tests pass a fake. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const AccessClaims = z.object({
  "https://api.openai.com/auth": z.object({ chatgpt_account_id: z.string().min(1) }),
});

/** The ChatGPT account id in an access token's claims; null when it has none. */
export function chatgptAccountId(token: string): string | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const claims = AccessClaims.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return claims.success ? claims.data["https://api.openai.com/auth"].chatgpt_account_id : null;
  } catch {
    return null;
  }
}

/**
 * Isaac's ChatGPT access token from omp, reused for a few minutes; one omp call at a time. Rejects
 * with a one-line reason (omp's stderr, never its stdout).
 */
export function ompCodexToken(omp: string | null, now: () => number = Date.now): () => Promise<string> {
  let cached: { readonly token: string; readonly at: number } | null = null;
  let inflight: Promise<string> | null = null;
  const fetchToken = (path: string): Promise<string> => {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    execFile(path, ["--profile", "personal", "token", "openai-codex"], { cwd: homedir(), timeout: 30_000 }, (error, stdout, stderr) => {
      const token = stdout.trim();
      if (error === null && token !== "") resolve(token);
      else reject(new Error(`omp token openai-codex failed: ${oneLine(stderr, 200) || (error?.message ?? "no token")}`));
    });
    return promise;
  };
  return () => {
    if (cached !== null && now() - cached.at < TOKEN_REUSE_MS) return Promise.resolve(cached.token);
    if (omp === null) return Promise.reject(new Error("omp not found (set $RELAY_CANVAS_OMP)"));
    inflight ??= fetchToken(omp)
      .then((token) => {
        cached = { token, at: now() };
        return token;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/** The request Codex's image endpoint takes for `spec`; `images` are JPEG bytes (edits). */
export function codexImageRequest(
  backend: "codex-image" | "codex-edit",
  spec: StudioSpec,
  token: string,
  accountId: string,
  images: readonly Uint8Array[],
): { readonly url: string; readonly init: RequestInit } {
  const common = { prompt: spec.prompt, model: CODEX_IMAGE_MODEL, n: 1, quality: "high", size: spec.resolution };
  const body =
    backend === "codex-edit"
      ? { images: images.map((bytes) => ({ image_url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}` })), ...common }
      : common;
  return {
    url: `${CODEX_IMAGES_URL}/${backend === "codex-edit" ? "edits" : "generations"}`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "chatgpt-account-id": accountId,
        originator: "codex_cli_rs",
        "User-Agent": "codex_cli_rs/0.200.0",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    },
  };
}

const ImageReply = z.object({ data: z.array(z.object({ b64_json: z.string().min(1) })).min(1) });
const ErrorReply = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
  detail: z.union([z.string(), z.object({ message: z.string() })]).optional(),
  message: z.string().optional(),
});

/** The server's own words for a failed request (a moderation refusal included), in one line. */
function codexError(status: number, body: string): string {
  let said = body;
  try {
    const parsed = ErrorReply.safeParse(JSON.parse(body));
    if (parsed.success) {
      const { error, detail, message } = parsed.data;
      const text = [error, detail].map((part) => (typeof part === "object" ? part.message : part)).find((part) => part !== undefined) ?? message;
      if (text !== undefined) said = text;
    }
  } catch {
    // Not JSON: the body as is.
  }
  return `Codex refused (HTTP ${String(status)}): ${oneLine(said, 400) || "no reason given"}`;
}

export interface CodexRunnerDeps {
  readonly backend: "codex-image" | "codex-edit";
  /** Isaac's ChatGPT access token. */
  readonly token: () => Promise<string>;
  readonly fetch: Fetch;
  /** An image file as JPEG bytes (edit references). */
  readonly jpeg: (path: string) => Promise<Uint8Array>;
}

export class CodexRunner implements StudioRunner {
  constructor(private readonly deps: CodexRunnerDeps) {}

  async describe(): Promise<StudioBackend> {
    const base = BACKEND_BASE[this.deps.backend];
    try {
      const token = await this.deps.token();
      if (chatgptAccountId(token) === null) return { ...base, available: false, reason: "The Codex sign-in in omp has no ChatGPT account" };
      return { ...base, available: true };
    } catch (error) {
      return { ...base, available: false, reason: oneLine(error, 400) };
    }
  }

  async run(input: StudioRunInput): Promise<StudioRunOutput> {
    const token = await this.deps.token();
    const accountId = chatgptAccountId(token);
    if (accountId === null) throw new Error("The Codex sign-in in omp has no ChatGPT account");
    const images = this.deps.backend === "codex-edit" ? await Promise.all(input.refs.map((path) => this.deps.jpeg(path))) : [];
    const { url, init } = codexImageRequest(this.deps.backend, input.spec, token, accountId, images);
    const response = await this.deps.fetch(url, { ...init, signal: input.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(codexError(response.status, text));
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("Codex sent a reply Relay could not read");
    }
    const reply = ImageReply.safeParse(json);
    if (!reply.success) throw new Error("Codex sent no image");
    const bytes = Buffer.from(reply.data.data[0]?.b64_json ?? "", "base64");
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const path = join(input.workDir, jpeg ? "out.jpg" : "out.png");
    writeFileSync(path, bytes, { mode: 0o600 });
    return { path, mimeType: jpeg ? "image/jpeg" : "image/png" };
  }
}

