# Relay

Turns an iPhone into a live extension of a Mac: trackpad, dictation into the focused Mac app,
and a view of the coding-agent sessions running on the Mac.

```
apps/mobile      Expo + React Native + TypeScript (Expo Router, Gesture Handler, Reanimated, Zustand)
apps/mac         Swift + SwiftUI menu-bar app (Network.framework, Bonjour, CGEvent, Accessibility)
packages/protocol  Wire protocol: zod schemas + JSON fixtures. apps/mac/Sources/RelayProtocol mirrors it.
tooling/         Shared eslint config
```

## Commands

```
pnpm install                       # once; also `pod install` happens inside `pnpm --filter @relay/mobile ios`
pnpm check                         # lint + typecheck + test + build, every package (turbo)
pnpm turbo run test --filter=@relay/protocol     # one package
pnpm turbo run lint typecheck test --filter=...[HEAD^1]   # only what changed since last commit
pnpm --filter @relay/mac test      # swift test
pnpm --filter @relay/mac bundle    # Relay.app, signed with a stable local identity (see apps/mac/scripts)
pnpm --filter @relay/mobile ios    # dev client on the simulator
```

## Protocol

`packages/protocol/src/index.ts` is the spec. Change it and `apps/mac/Sources/RelayProtocol/Protocol.swift`
together; `swift test` decodes every fixture in `packages/protocol/fixtures` and re-encodes it.
