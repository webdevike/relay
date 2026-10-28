import { describe, expect, it } from "vitest";
import { allowedTarget, mayDiscover, parseOnlyHost } from "./only-host";

describe("only host", () => {
  it("changes nothing when unset or blank", () => {
    for (const raw of [undefined, "", "  "]) {
      const only = parseOnlyHost(raw);
      expect(only).toEqual({ kind: "any" });
      expect(allowedTarget(only, "Isaac's Mac")).toBe("Isaac's Mac");
      expect(allowedTarget(only, null)).toBeNull();
      expect(mayDiscover(only)).toBe(true);
    }
  });

  it("pins every target to the manual host and never discovers", () => {
    const only = parseOnlyHost("127.0.0.1:7900");
    expect(only).toEqual({ kind: "only", id: "127.0.0.1:7900" });
    // Boot with a saved live host, a switch from the picker, a forget that would fall back to discovery.
    expect(allowedTarget(only, "Isaac's Mac")).toBe("127.0.0.1:7900");
    expect(allowedTarget(only, "100.64.0.1:7817")).toBe("127.0.0.1:7900");
    expect(allowedTarget(only, null)).toBe("127.0.0.1:7900");
    expect(mayDiscover(only)).toBe(false);
  });

  it("normalizes the pin like a typed host, IPv6 included", () => {
    expect(parseOnlyHost(" [::1]:7900 ")).toEqual({ kind: "only", id: "::1:7900" });
  });

  it("connects nowhere on a malformed pin instead of falling back to discovery", () => {
    const only = parseOnlyHost("localhost");
    expect(only).toEqual({ kind: "invalid", raw: "localhost" });
    expect(allowedTarget(only, "Isaac's Mac")).toBeNull();
    expect(mayDiscover(only)).toBe(false);
  });
});
