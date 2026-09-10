# Relay

Turns an iPhone into a live extension of a Mac: trackpad, dictation into the focused Mac app,
and a view of the coding-agent sessions running on the Mac.

```
apps/mobile      Expo + React Native + TypeScript (Expo Router, Gesture Handler, Reanimated, Zustand)
apps/mac         Swift + SwiftUI menu-bar app (Network.framework, Bonjour, CGEvent, Accessibility)
apps/linux       Bun + TypeScript host daemon (Bun.serve WebSocket, avahi, /dev/uinput, wtype). See apps/linux/README.md
packages/protocol  Wire protocol: zod schemas + JSON fixtures. apps/mac/Sources/RelayProtocol mirrors it.
tooling/         Shared eslint config
```

## Toolchain

- pnpm 9 (`packageManager` in package.json; the global pnpm on this Mac is v6, so use `npx -y pnpm@9.15.0 …` or corepack), hoisted `node_modules` (`.npmrc`).
- Expo SDK 54 / RN 0.81, pinned because Expo 55+ needs Xcode 26 and this Mac runs Xcode 16.4. Bump both together.
- Watchman installed (`brew install watchman`), otherwise Metro misses edits in the monorepo.
- V1 ships trackpad + dictation. Coding-agent sessions are deferred: the protocol types, `AgentProvider` seam and `useAgentsStore` stay so a provider can be added without a schema change.

## Commands

```
npx -y pnpm@9.15.0 install
npx -y pnpm@9.15.0 turbo run lint typecheck test build            # everything (11 tasks)
npx -y pnpm@9.15.0 turbo run test --filter=@relay/protocol        # one package
npx -y pnpm@9.15.0 turbo run lint typecheck test --filter=...[HEAD^1]   # only what changed
cd apps/mac && swift test                                          # Mac unit + socket tests
cd apps/mac && sh scripts/setup-identity.sh && sh scripts/bundle.sh && open build/Relay.app
cd apps/mobile && npx expo prebuild --platform ios && (cd ios && pod install)
cd apps/mobile && npx expo start --dev-client                      # NOT with CI=1: that disables watch mode
cd apps/linux && bun run src/main.ts serve                        # Linux host daemon (PIN prints here)
```

Simulator dev client: build with `xcodebuild -workspace ios/Relay.xcworkspace -scheme Relay -sdk iphonesimulator …`, install with `xcrun simctl install`. Physical iPhone on iOS 27 cannot be driven by Xcode 16.4; use `eas build --profile development --platform ios` (apps/mobile/eas.json) and install from the link.

## Pairing and security (V1)

Plaintext WebSocket on the LAN. First contact: the Mac shows a 6-digit PIN for 120 s, the phone sends it, the Mac issues a 32-byte secret stored in the Keychain on both sides. Every later connection is `challenge` (32-byte nonce) → `auth` (HMAC-SHA256 proof) → `welcome`. Trackpad input is dropped, never queued, when disconnected; commands are acked and deduplicated by id across reconnects. No TLS yet: fine at home, not on hostile Wi-Fi.

## Protocol

`packages/protocol/src/index.ts` is the spec. Change it and `apps/mac/Sources/RelayProtocol/Protocol.swift`
together; `swift test` decodes every fixture in `packages/protocol/fixtures` and re-encodes it.
