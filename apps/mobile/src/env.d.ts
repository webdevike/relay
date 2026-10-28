// Bundle-time env read with dot access (Expo inlines only `process.env.EXPO_PUBLIC_*` written that way).
declare namespace NodeJS {
  interface ProcessEnv {
    /** `host:port`: pin the bundle to this one host, no discovery (src/connection/only-host.ts). */
    readonly EXPO_PUBLIC_RELAY_ONLY_HOST?: string;
  }
}
