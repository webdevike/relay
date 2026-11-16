import { beforeEach, describe, expect, it } from "vitest";
import { redirectSystemPath } from "../../app/+native-intent";
import { useLinkNotice } from "@/state/linkNotice";
import { useThreadHandoff } from "@/state/threadHandoff";
import { LINK_KINDS } from "./linkKinds.fixture";

beforeEach(() => {
  useLinkNotice.setState({ notice: null, seq: 0 });
  useThreadHandoff.setState({ handoffs: {} });
});

// What iOS hands the router when a relay:// link is tapped in Safari, Notes or a notification.
describe("redirectSystemPath", () => {
  it.each(LINK_KINDS.map((k) => [k.what, k] as const))("%s", (_what, kind) => {
    expect(redirectSystemPath({ path: kind.url, initial: true })).toBe(kind.phone);
    expect(useLinkNotice.getState().notice).toBe(kind.notice ?? null);
  });

  it("says a fallback again when the same link is tapped twice", () => {
    redirectSystemPath({ path: "relay://open/jobs", initial: false });
    redirectSystemPath({ path: "relay://open/jobs", initial: false });
    expect(useLinkNotice.getState().seq).toBe(2);
  });

  it("leaves router paths and dev-client links alone", () => {
    expect(redirectSystemPath({ path: "/settings", initial: false })).toBe("/settings");
    expect(
      redirectSystemPath({ path: "relay://expo-development-client/?url=x", initial: true }),
    ).toBe("relay://expo-development-client/?url=x");
    expect(useLinkNotice.getState().notice).toBeNull();
  });

  it("opens an assistant link's ?send= as a draft in that thread, never a send", () => {
    expect(
      redirectSystemPath({ path: "relay://assistant/penny?send=Add%20the%20lamp", initial: true }),
    ).toBe("/eva?agent=penny");
    expect(useThreadHandoff.getState().take("penny")).toEqual({
      agent: "penny",
      text: "Add the lamp",
      send: false,
    });
    expect(redirectSystemPath({ path: "relay://assistant/penny?draft=hi", initial: false })).toBe(
      "/eva?agent=penny",
    );
    expect(useThreadHandoff.getState().take("penny")).toEqual({
      agent: "penny",
      text: "hi",
      send: false,
    });
  });
});
