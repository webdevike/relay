import { beforeEach, describe, expect, it, vi } from "vitest";

import { openChatLink } from "./links";

const { openURL, push } = vi.hoisted(() => ({ openURL: vi.fn((_url: string) => Promise.resolve()), push: vi.fn() }));
vi.mock("react-native", () => ({ Linking: { openURL } }));
vi.mock("expo-router", () => ({ router: { push } }));

beforeEach(() => {
  openURL.mockClear();
  push.mockClear();
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
