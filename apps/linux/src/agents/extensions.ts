// The omp extensions the host needs in the user's omp agent dir (`~/.omp/agent/extensions`):
// relay-bridge.ts (how a session reports to this host) and herdr-omp-agent-state.ts (herdr's
// agent state). A missing one is created at start, from `$RELAY_OMP_EXTENSION_DIR` when set, else
// the host bundle (`Resources/omp-extension` beside the binary: Relay Host.app, the Nix package),
// else `apps/linux/omp-extension` in a checkout or, for herdr's, by `herdr integration install omp`.
// Bundled files are self-contained and copied; the checkout's relay-bridge.ts imports `../src` by
// relative path, so it is symlinked to keep those imports resolving. One that exists, whatever it
// holds or points at, is never touched.

import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveTool, toolPath } from "../host-config";

const BRIDGE = "relay-bridge.ts";
const HERDR_STATE = "herdr-omp-agent-state.ts";

export function ompExtensionsDir(): string {
  return join(homedir(), ".omp", "agent", "extensions");
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** `apps/linux/omp-extension` in a checkout: its files import the host's sources by relative path. */
const CHECKOUT_DIR = join(import.meta.dirname, "..", "..", "omp-extension");

/** Directories that may hold the extension files: `$RELAY_OMP_EXTENSION_DIR`, the packaged app's, then the checkout's. */
export function bundleDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env["RELAY_OMP_EXTENSION_DIR"]?.trim();
  return [
    ...(override === undefined || override === "" ? [] : [override]),
    join(dirname(process.execPath), "..", "Resources", "omp-extension"),
    CHECKOUT_DIR,
  ];
}

function bundled(name: string): string | null {
  return bundleDirs().map((dir) => join(dir, name)).find((path) => existsSync(path)) ?? null;
}

/** Whether `source` is the checkout's unbundled file, which only works where it lies (symlinked, never copied). */
export function isCheckoutSource(source: string, checkoutDir: string = CHECKOUT_DIR): boolean {
  try {
    return realpathSync(dirname(source)) === realpathSync(checkoutDir);
  } catch {
    return false;
  }
}

/** Creates whichever of the two extensions is missing; never overwrites. Failures are logged, not thrown. */
export async function ensureOmpExtensions(log: (line: string) => void): Promise<void> {
  const dir = ompExtensionsDir();
  for (const name of [BRIDGE, HERDR_STATE]) {
    const target = join(dir, name);
    if (present(target)) continue;
    const source = bundled(name);
    try {
      if (source !== null) {
        mkdirSync(dir, { recursive: true });
        if (isCheckoutSource(source)) {
          symlinkSync(realpathSync(source), target);
          log(`omp extension ${name} linked to ${source}`);
        } else {
          copyFileSync(source, target);
          log(`omp extension ${name} installed from ${source}`);
        }
      } else if (name === HERDR_STATE) {
        const herdr = resolveTool("herdr");
        if (herdr === null) {
          log(`omp extension ${name} missing and herdr is not installed yet`);
          continue;
        }
        const proc = Bun.spawn([herdr, "integration", "install", "omp"], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: { ...process.env, PATH: toolPath() } });
        const code = await proc.exited;
        log(code === 0 ? `omp extension ${name} installed with herdr integration install omp` : `omp extension ${name}: herdr integration install omp failed: ${(await new Response(proc.stderr).text()).trim()}`);
      } else {
        log(`omp extension ${name} missing and not bundled with this host`);
      }
    } catch (error) {
      log(`omp extension ${name} not installed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
