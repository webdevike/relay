import { serverConfig } from "./config";
import { handle } from "./server";

/** relay-ota: Expo Updates server for Relay, on loopback behind `tailscale serve`. */
const config = serverConfig();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      const response = await handle(request, config);
      if (!url.pathname.startsWith("/assets/") || response.status !== 200) {
        const platform = request.headers.get("expo-platform") ?? "-";
        const runtime = request.headers.get("expo-runtime-version") ?? "-";
        console.log(`${new Date().toISOString()} ${response.status} ${url.pathname} ${platform} ${runtime}`);
      }
      return response;
    } catch (error) {
      console.error(`${new Date().toISOString()} 500 ${url.pathname}`, error);
      return new Response("Internal error\n", { status: 500 });
    }
  },
});

console.log(`relay-ota on http://127.0.0.1:${server.port}, data ${config.dataRoot}, public ${config.publicUrl}`);
