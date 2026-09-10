import { describe, expect, it } from "vitest";
import { parseManualHost } from "./manual-host";
import { pickCandidate } from "./candidate";

describe("parseManualHost", () => {
  it("accepts host:port forms and yields a service the candidate policy accepts", () => {
    const ipv4 = parseManualHost(" 100.66.193.57:7817 ");
    expect(ipv4).toEqual({ name: "100.66.193.57:7817", host: "100.66.193.57", port: 7817, txt: { v: "1" } });
    expect(parseManualHost("omarchy-2.local:7817")?.host).toBe("omarchy-2.local");
    expect(parseManualHost("[fd7a:115c:a1e0::1]:7817")).toMatchObject({ host: "fd7a:115c:a1e0::1", port: 7817 });
    if (ipv4 === null) throw new Error("unreachable");
    expect(pickCandidate([ipv4], null)).toBe(ipv4);
    expect(pickCandidate([ipv4], ipv4.name)).toBe(ipv4);
  });

  it("rejects empty, port-less, out-of-range and unbracketed IPv6 input", () => {
    for (const bad of ["", "   ", "omarchy", "omarchy:", ":7817", "host:0", "host:65536", "host:7817:1", "fd7a::1:7817", "a b:80"]) {
      expect(parseManualHost(bad), bad).toBeNull();
    }
  });
});
