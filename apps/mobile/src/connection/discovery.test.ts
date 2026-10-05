import { describe, expect, it } from "vitest";
import { pickCandidate, type DiscoveredService } from "./candidate";

function service(name: string, v = "1"): DiscoveredService {
  return { name, host: "192.168.1.10", port: 8443, txt: { v } };
}

describe("pickCandidate", () => {
  it("filters out services with a mismatched or missing protocol TXT version", () => {
    const services = [service("old-mac", "0"), service("no-version", ""), service("current-mac", "1")];
    expect(pickCandidate(services, [])).toEqual(service("current-mac", "1"));
  });

  it("picks the first valid service when no Mac is paired", () => {
    const services = [service("mac-a"), service("mac-b")];
    expect(pickCandidate(services, [])).toEqual(service("mac-a"));
  });

  it("prefers the first remembered host that is present", () => {
    const services = [service("mac-a"), service("mac-b"), service("mac-c")];
    expect(pickCandidate(services, ["mac-c", "mac-b"])).toEqual(service("mac-c"));
  });

  it("allows a new host into the authenticated pairing flow when remembered hosts are absent", () => {
    const services = [service("mac-a")];
    expect(pickCandidate(services, ["mac-b"])).toEqual(service("mac-a"));
  });

  it("returns null when nothing has resolved yet", () => {
    expect(pickCandidate([], [])).toBeNull();
  });
});
