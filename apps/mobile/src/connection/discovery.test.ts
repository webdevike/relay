import { describe, expect, it } from "vitest";
import { pickCandidate, type DiscoveredService } from "./candidate";

function service(name: string, v = "1"): DiscoveredService {
  return { name, host: "192.168.1.10", port: 8443, txt: { v } };
}

describe("pickCandidate", () => {
  it("filters out services with a mismatched or missing protocol TXT version", () => {
    const services = [service("old-mac", "0"), service("no-version", ""), service("current-mac", "1")];
    expect(pickCandidate(services, null)).toEqual(service("current-mac", "1"));
  });

  it("picks the first valid service when no Mac is paired", () => {
    const services = [service("mac-a"), service("mac-b")];
    expect(pickCandidate(services, null)).toEqual(service("mac-a"));
  });

  it("matches only the paired bonjour name when a Mac is paired", () => {
    const services = [service("mac-a"), service("mac-b")];
    expect(pickCandidate(services, "mac-b")).toEqual(service("mac-b"));
  });

  it("returns null when the paired Mac is not among the resolved services", () => {
    const services = [service("mac-a")];
    expect(pickCandidate(services, "mac-b")).toBeNull();
  });

  it("returns null when nothing has resolved yet", () => {
    expect(pickCandidate([], null)).toBeNull();
  });
});
