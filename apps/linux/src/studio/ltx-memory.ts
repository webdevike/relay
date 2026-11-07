// Memory for an LTX video run. LTX needs most of the Mac's unified memory, so while it runs the other big
// residents give theirs back: ComfyUI unloads its models (`POST /free`, done by `ComfyUIRunner.release`) and
// the local Qwen prompt enhancer's launchd job is booted out; afterwards the enhancer is bootstrapped again.
// The service calls this only while it holds the machine-wide GPU lock, so no ComfyUI, Kontext or SAM job is
// running that the unload could pull the models out from under.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const QWEN_LABEL = "ai.eva.qwen-local";

/** Memory hooks around one LTX run. Both are best effort: a failure is logged, never fails the job. */
export interface LtxMemory {
  prepare(): Promise<void>;
  restore(): Promise<void>;
}

export type Launchctl = (args: readonly string[]) => Promise<void>;

export interface LtxMemoryDeps {
  /** Unloads each ComfyUI server's models (`ComfyUIRunner.release`, which never rejects). */
  readonly freeComfy: readonly (() => Promise<void>)[];
  readonly launchctl: Launchctl;
  readonly uid: number;
  /** The enhancer's LaunchAgent plist; when it is missing the enhancer is not managed here and is left alone. */
  readonly qwenPlist: string;
  readonly log: (line: string) => void;
}

export class LaunchdLtxMemory implements LtxMemory {
  constructor(private readonly deps: LtxMemoryDeps) {}

  async prepare(): Promise<void> {
    await Promise.all(
      this.deps.freeComfy.map((free) =>
        free().catch((error: unknown) => {
          this.warn("ComfyUI unload", error);
        }),
      ),
    );
    if (!existsSync(this.deps.qwenPlist)) return;
    // Booting out a service that is not loaded (memwatch already did) fails; that is the state we want anyway.
    await this.deps.launchctl(["bootout", `gui/${String(this.deps.uid)}/${QWEN_LABEL}`]).catch(() => undefined);
  }

  async restore(): Promise<void> {
    if (!existsSync(this.deps.qwenPlist)) return;
    // Bootstrapping one that is already loaded fails with "already bootstrapped"; nothing to restore then.
    await this.deps.launchctl(["bootstrap", `gui/${String(this.deps.uid)}`, this.deps.qwenPlist]).catch(() => undefined);
  }

  private warn(what: string, error: unknown): void {
    this.deps.log(`studio: LTX memory: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function systemLaunchctl(args: readonly string[]): Promise<undefined> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  execFile("/bin/launchctl", [...args], { timeout: 15_000 }, (error) => {
    if (error === null) resolve(undefined);
    else reject(error);
  });
  return promise;
}

export function defaultQwenPlist(): string {
  return join(homedir(), "Library", "LaunchAgents", `${QWEN_LABEL}.plist`);
}
