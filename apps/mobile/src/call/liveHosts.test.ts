import { describe, expect, it } from "vitest";
import type { PairedHost } from "@/connection/hosts";
import { liveCallHosts } from "./liveHosts";

const mini: PairedHost = { id: "Isaac's Mac mini", name: "Mac mini", address: "192.168.1.20:7899", secretHex: "aa" };
const tailnet: PairedHost = { id: "isaacs-mac-mini.tail80fdb0.ts.net:7899", name: "Mac mini (tailnet)", address: "100.64.0.2:7899", secretHex: "bb" };
const fresh: PairedHost = { id: "omarchy._relay._tcp", name: "omarchy", address: "", secretHex: "cc" };

const base = { deviceId: "dev-1", deviceName: "Isaac's iPhone" };

describe("liveCallHosts", () => {
  it("puts the authority the app is connected through first, with that host's secret", () => {
    const hosts = liveCallHosts({ ...base, authority: "10.0.0.5:7899", activeId: mini.id, hosts: [tailnet, mini] });
    expect(hosts.map((host) => host.url)).toEqual([
      "ws://10.0.0.5:7899/relay",
      "ws://192.168.1.20:7899/relay",
      "ws://100.64.0.2:7899/relay",
      "ws://isaacs-mac-mini.tail80fdb0.ts.net:7899/relay",
    ]);
    expect(hosts[0]).toEqual({ url: "ws://10.0.0.5:7899/relay", deviceId: "dev-1", deviceName: "Isaac's iPhone", secretHex: "aa", name: "Mac mini" });
    expect(hosts.map((host) => host.secretHex)).toEqual(["aa", "aa", "bb", "bb"]);
  });

  it("lists each address once and skips hosts with no known address", () => {
    const hosts = liveCallHosts({ ...base, authority: "192.168.1.20:7899", activeId: mini.id, hosts: [mini, fresh] });
    expect(hosts.map((host) => host.url)).toEqual(["ws://192.168.1.20:7899/relay"]);
  });

  it("without a live connection, starts from the active host's saved addresses", () => {
    const hosts = liveCallHosts({ ...base, authority: null, activeId: tailnet.id, hosts: [mini, tailnet] });
    expect(hosts.map((host) => host.url)).toEqual([
      "ws://100.64.0.2:7899/relay",
      "ws://isaacs-mac-mini.tail80fdb0.ts.net:7899/relay",
      "ws://192.168.1.20:7899/relay",
    ]);
  });

  it("brackets a typed IPv6 host and never sends an empty device name", () => {
    const v6: PairedHost = { id: "[fd7a::1]:7899", name: "v6", address: "", secretHex: "dd" };
    const hosts = liveCallHosts({ deviceId: "dev-1", deviceName: " ", authority: null, activeId: v6.id, hosts: [v6] });
    expect(hosts).toEqual([{ url: "ws://[fd7a::1]:7899/relay", deviceId: "dev-1", deviceName: "iPhone", secretHex: "dd", name: "v6" }]);
  });

  it("is empty with nothing paired", () => {
    expect(liveCallHosts({ ...base, authority: null, activeId: null, hosts: [] })).toEqual([]);
  });
});
