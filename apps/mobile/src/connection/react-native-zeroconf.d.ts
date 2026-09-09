/**
 * `react-native-zeroconf` ships no types (plain Babel-compiled JS, no `.d.ts`, no `@types`
 * package). Minimal ambient shim covering only what `discovery.ts` uses.
 */
declare module "react-native-zeroconf" {
  export interface ZeroconfService {
    name: string;
    host: string;
    port: number;
    addresses?: string[];
    txt?: Record<string, string>;
    fullName?: string;
  }

  export default class Zeroconf {
    on(event: "resolved", listener: (service: ZeroconfService) => void): this;
    on(event: "remove", listener: (name: string) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "start" | "stop" | "found" | "update" | "published" | "unpublished", listener: () => void): this;
    scan(type?: string, protocol?: string, domain?: string): void;
    stop(): void;
  }
}
