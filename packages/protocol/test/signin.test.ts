import { describe, expect, it } from "vitest";
import { splitSignin } from "../src/signin";

describe("sign-in token", () => {
  it("strips the token from a reply and carries url and host", () => {
    expect(splitSignin("Sign in to GitHub.\n[[signin:https://github.com/login]]", false)).toEqual({
      text: "Sign in to GitHub.",
      signin: { url: "https://github.com/login", host: "github.com" },
    });
    expect(splitSignin("[[signin:http://localhost:3000/x?a=1]]\n", false)).toEqual({ text: "", signin: { url: "http://localhost:3000/x?a=1", host: "localhost" } });
  });

  it("cuts a token that is not an http(s) url without a card, and leaves a token in mid-text alone", () => {
    expect(splitSignin("hi [[signin:javascript:alert(1)]]", false)).toEqual({ text: "hi" });
    expect(splitSignin("hi [[signin:not a url]]", false)).toEqual({ text: "hi [[signin:not a url]]" });
    expect(splitSignin("[[signin:https://a.com]] then more", false)).toEqual({ text: "[[signin:https://a.com]] then more" });
  });

  it("hides a token that is still streaming in, but not other text", () => {
    for (const partial of ["Sign in.\n[", "Sign in.\n[[", "Sign in.\n[[sig", "Sign in.\n[[signin:", "Sign in.\n[[signin:https://git"]) {
      expect(splitSignin(partial, true)).toEqual({ text: "Sign in." });
      expect(splitSignin(partial, false)).toEqual({ text: partial });
    }
    expect(splitSignin("array[[0]] is", true)).toEqual({ text: "array[[0]] is" });
    expect(splitSignin("done\n[[signin:https://github.com/login]]", true).signin?.host).toBe("github.com");
  });
});
