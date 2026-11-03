import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleVersion, plistVersion } from "../src/bundle-version";

describe("bundleVersion", () => {
  it("reads the short version from an Info.plist", () => {
    expect(
      plistVersion("<dict><key>CFBundleShortVersionString</key><string>0.2.52</string></dict>"),
    ).toBe("0.2.52");
    expect(plistVersion("<dict></dict>")).toBeNull();
  });

  it("finds the plist of the bundle the binary runs from, null elsewhere", () => {
    const app = mkdtempSync(join(tmpdir(), "host-")) + "/Relay Host.app/Contents";
    mkdirSync(join(app, "MacOS"), { recursive: true });
    writeFileSync(
      join(app, "Info.plist"),
      "<key>CFBundleShortVersionString</key><string>0.2.52</string>",
    );
    expect(bundleVersion(join(app, "MacOS/relay-host"))).toBe("0.2.52");
    expect(bundleVersion("/nonexistent/bin/relay-host")).toBeNull();
  });
});
