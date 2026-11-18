import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleDirs, isCheckoutSource } from "../src/agents/extensions";
import { isOmpCommand } from "../src/canvas/caller";
import { defaultServeDirs, gecosName, relayCli, supportDir } from "../src/host-config";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("relayCli", () => {
  it("is the compiled binary itself, bun on a source or bundled entry, or $RELAY_CLI", () => {
    expect(
      relayCli(
        {},
        "/$bunfs/root/relay-host",
        "/Applications/Relay Host.app/Contents/MacOS/relay-host",
      ),
    ).toBe('"/Applications/Relay Host.app/Contents/MacOS/relay-host"');
    expect(
      relayCli({}, "/home/jane/relay/apps/linux/src/main.ts", "/nix/store/x-bun/bin/bun"),
    ).toBe('bun "/home/jane/relay/apps/linux/src/main.ts"');
    expect(relayCli({}, "/nix/store/y-relay/lib/relay-host.js", "/nix/store/x-bun/bin/bun")).toBe(
      'bun "/nix/store/y-relay/lib/relay-host.js"',
    );
    expect(relayCli({ RELAY_CLI: " relay-host " }, "/x/main.ts", "/bun")).toBe("relay-host");
    expect(relayCli({ RELAY_CLI: "" }, "/$bunfs/root/relay-host", "/usr/bin/relay-host")).toBe(
      '"/usr/bin/relay-host"',
    );
  });
});

describe("serve's default dirs", () => {
  it("puts the support dir in Application Support on macOS and XDG config elsewhere", () => {
    expect(supportDir({}, "darwin")).toBe(join(homedir(), "Library", "Application Support"));
    expect(supportDir({ XDG_CONFIG_HOME: "/x/cfg" }, "darwin")).toBe(
      join(homedir(), "Library", "Application Support"),
    );
    expect(supportDir({ XDG_CONFIG_HOME: "/x/cfg" }, "linux")).toBe("/x/cfg");
    expect(supportDir({ XDG_CONFIG_HOME: "" }, "linux")).toBe(join(homedir(), ".config"));
    expect(supportDir({}, "linux")).toBe(join(homedir(), ".config"));
  });

  it("uses EvaOS canvases for the owner's Mac setup and Relay's own elsewhere; boards only off macOS", () => {
    const none = (): boolean => false;
    const config = { features: {} };
    expect(defaultServeDirs(null, "/s", "darwin", none)).toEqual({
      canvases: "/s/EvaOS/canvases",
      boards: null,
    });
    expect(defaultServeDirs(config, "/s", "darwin", none)).toEqual({
      canvases: "/s/Relay/canvases",
      boards: null,
    });
    expect(
      defaultServeDirs(config, "/s", "darwin", (path) => path === "/s/EvaOS/canvases"),
    ).toEqual({ canvases: "/s/EvaOS/canvases", boards: null });
    expect(defaultServeDirs(config, "/home/jane/.config", "linux", none)).toEqual({
      canvases: "/home/jane/.config/Relay/canvases",
      boards: "/home/jane/.config/Relay/boards",
    });
    // Linux before setup (no host.json yet): Relay's own, so the dir the desktop reads is the one created.
    expect(defaultServeDirs(null, "/c", "linux", none)).toEqual({
      canvases: "/c/Relay/canvases",
      boards: "/c/Relay/boards",
    });
    expect(defaultServeDirs(null, "/c", "linux", (path) => path === "/c/EvaOS/canvases")).toEqual({
      canvases: "/c/EvaOS/canvases",
      boards: "/c/Relay/boards",
    });
  });
});

describe("gecosName", () => {
  it("reads the full name from a passwd line", () => {
    expect(
      gecosName("jane:x:1000:100:Jane Doe,,,:/home/jane:/run/current-system/sw/bin/bash"),
    ).toBe("Jane Doe");
    expect(gecosName("jane:x:1000:100:Jane:/home/jane:/bin/sh")).toBe("Jane");
    expect(gecosName("jane:x:1000:100::/home/jane:/bin/sh")).toBeNull();
    expect(gecosName("")).toBeNull();
  });
});

describe("isOmpCommand", () => {
  it("matches omp itself everywhere and its Nix wrapper or interpreter forms on Linux only", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(isOmpCommand("/Users/ike/.local/bin/omp --resume=/x.jsonl", platform)).toBe(true);
      expect(isOmpCommand("omp", platform)).toBe(true);
      expect(isOmpCommand("/bin/bash -c relay-host canvas start --omp", platform)).toBe(false);
      expect(isOmpCommand("/usr/bin/bun /home/x/.omp/tools/agent-session.ts", platform)).toBe(
        false,
      );
    }
    expect(isOmpCommand("/nix/store/abc-omp/bin/.omp-wrapped --mode rpc", "linux")).toBe(true);
    expect(isOmpCommand("/nix/store/abc-bun/bin/bun /home/jane/.bun/bin/omp", "linux")).toBe(true);
    expect(
      isOmpCommand("node /usr/lib/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js", "linux"),
    ).toBe(true);
    expect(isOmpCommand("/nix/store/abc-omp/bin/.omp-wrapped --mode rpc", "darwin")).toBe(false);
    expect(isOmpCommand("bun /home/jane/.bun/bin/omp", "darwin")).toBe(false);
  });
});

describe("omp extension sources", () => {
  it("looks in $RELAY_OMP_EXTENSION_DIR first, then the packaged Resources, then the checkout", () => {
    const [first, packaged, checkout] = bundleDirs({
      RELAY_OMP_EXTENSION_DIR: "/nix/store/r/Resources/omp-extension",
    });
    expect(first).toBe("/nix/store/r/Resources/omp-extension");
    expect(packaged).toMatch(/Resources\/omp-extension$/);
    expect(checkout).toMatch(/apps\/linux\/omp-extension$/);
    expect(bundleDirs({ RELAY_OMP_EXTENSION_DIR: " " })).toHaveLength(2);
  });

  it("symlinks only the checkout's own file, also through a symlinked path", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-ext-"));
    dirs.push(root);
    const checkout = join(root, "checkout");
    const bundle = join(root, "bundle");
    mkdirSync(checkout);
    mkdirSync(bundle);
    writeFileSync(join(checkout, "relay-bridge.ts"), "");
    writeFileSync(join(bundle, "relay-bridge.ts"), "");
    symlinkSync(checkout, join(root, "link"));
    expect(isCheckoutSource(join(checkout, "relay-bridge.ts"), checkout)).toBe(true);
    expect(isCheckoutSource(join(root, "link", "relay-bridge.ts"), checkout)).toBe(true);
    expect(isCheckoutSource(join(bundle, "relay-bridge.ts"), checkout)).toBe(false);
  });
});
