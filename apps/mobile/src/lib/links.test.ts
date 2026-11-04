import { beforeEach, describe, expect, it, vi } from "vitest";

import { openChatLink, openWidgetUrl } from "./links";

const { openURL, push, navigate } = vi.hoisted(() => ({
  openURL: vi.fn((_url: string) => Promise.resolve()),
  push: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("react-native", () => ({ Linking: { openURL } }));
vi.mock("expo-router", () => ({ router: { push, navigate } }));

beforeEach(() => {
  openURL.mockClear();
  push.mockClear();
  navigate.mockClear();
});

describe("openChatLink", () => {
  it("opens a PR, Linear issue or Slack permalink in Reviews", () => {
    const urls = [
      "https://github.com/eCardSystems/api/pull/246",
      "https://linear.app/ecard/issue/ENG-6693",
      "https://ecard.slack.com/archives/C0123ABC/p1730000000123456",
    ];
    for (const url of urls) openChatLink(url);
    expect(push.mock.calls.map((c) => c[0])).toEqual(urls.map((url) => `/reviews?item=${encodeURIComponent(url)}`));
    expect(openURL).not.toHaveBeenCalled();
  });

  it("leaves the app for any other link", () => {
    openChatLink("https://example.com/post");
    openChatLink("https://github.com/eCardSystems/api/issues/3");
    expect(openURL.mock.calls.map((c) => c[0])).toEqual(["https://example.com/post", "https://github.com/eCardSystems/api/issues/3"]);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("openWidgetUrl", () => {
  it("keeps relay:// links in the app", () => {
    openWidgetUrl("relay://assistant/nova");
    expect(navigate).toHaveBeenLastCalledWith({ pathname: "/eva", params: { agent: "nova" } });
    openWidgetUrl("relay://open/settings");
    expect(navigate).toHaveBeenLastCalledWith("/settings");
    openChatLink("relay://assistant/astra");
    expect(navigate).toHaveBeenLastCalledWith({ pathname: "/eva", params: { agent: "astra" } });
    openWidgetUrl("relay://open/jobs");
    expect(navigate).toHaveBeenCalledTimes(3);
    expect(openURL).not.toHaveBeenCalled();
  });

  it("follows a deep link's section and Reviews item, and swallows pages the phone lacks", () => {
    openChatLink("relay://open/settings/connections?connect=github");
    expect(navigate).toHaveBeenLastCalledWith("/settings");
    const item = "https://github.com/o/r/pull/12";
    openChatLink(`relay://open/reviews?item=${encodeURIComponent(item)}`);
    expect(push).toHaveBeenLastCalledWith(`/reviews?item=${encodeURIComponent(item)}`);
    openChatLink("relay://open/test-bench?experiment=x&arm=a");
    expect(openURL).not.toHaveBeenCalled();
  });

  it("opens a web url externally", () => {
    openWidgetUrl("https://example.com");
    expect(openURL).toHaveBeenCalledWith("https://example.com");
    expect(navigate).not.toHaveBeenCalled();
  });
});
