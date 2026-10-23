# Relay

Turns an iPhone into a live extension of a Mac: trackpad, dictation into the focused Mac app,
a live view of the whole desktop (noVNC over the host's authenticated bridge to macOS Screen
Sharing; see apps/linux/README.md), and a view of the coding-agent sessions running on the Mac.

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

## Typed agent replies

The Agent Inbox composer is one multiline field with a 44-point Send button pinned inside its bottom-right corner; swiping the keyboard away returns to voice. Its static panel keeps the button unclipped as the draft grows. Enabled Send taps provide one light haptic when Settings > Haptics is on; blank or busy drafts cannot send.

Long-press a GPT session in the scrubber to choose Current, Personal, or Work for the next session.
The account setting stays hidden for non-GPT models because only ChatGPT authentication uses it.
Settings > omp account supplies its initial default. Named choices pass `--profile personal` or
`--profile work` to omp on the host, keeping authentication, sessions, settings, and caches separate.
Log into each named profile once on the host.

## Pairing and security (V1)

Plaintext WebSocket on the LAN. A physically paired iPhone can receive quick trust through its protected app-data channel, with no PIN entry; the transient transfer file is deleted after its secret moves into Keychain. Other first contacts use a 6-digit PIN for 120 s. The phone keeps independent credentials per connection target, so switching computers does not replace existing trust. Every later connection is `challenge` (32-byte nonce) → `auth` (HMAC-SHA256 proof) → `welcome`. Trackpad input is dropped, never queued, when disconnected; commands are acked and deduplicated by id across reconnects. No TLS yet: fine at home, not on hostile Wi-Fi.

## Protocol

`packages/protocol/src/index.ts` is the spec. Change it and `apps/mac/Sources/RelayProtocol/Protocol.swift`
together; `swift test` decodes every fixture in `packages/protocol/fixtures` and re-encodes it.

Widgets: `src/widget.ts` is the widget schema (the JSON ```ui fence, kept for old transcripts).
Agents now emit OpenUI Lang in a ```openui fence; `src/openui/` parses it (also mid-stream) into the
same validated tree (`parseOpenUI`, `toOpenUI`, `relayWidgetPrompt`), with the parser vendored from
thesysdev/openui lang-core in `src/openui/lang/` (upstream commit in its `LICENSE-openui`). Check a
reply's blocks with `bun packages/protocol/src/openui/check.ts < reply.md`. A widget or field change
in `widget.ts` also updates `src/openui/library.ts`.

Interactive widgets: `$name = default` state, expressions and the `@Set`/`@Reset` steps run on the
device through `createOpenUIRuntime(text, { partial })` (vendored lang-core evaluator and store in
`src/openui/lang/runtime/`; no Node, DOM or code evaluation, so it runs under Hermes and in the
Electron renderer). `snapshot()` returns the tree evaluated against the current state (the same
object until something changes), `subscribe` reports changes, `update` re-parses streamed text
while keeping the values the user changed, and two optional `WidgetSpec` fields connect the
renderer to it. Only runtime trees carry them; `parseWidget` drops them from ```ui JSON:

- Button `action?: string`: an opaque action id, set instead of `url`/`reply` when the button's
  action has a local step. On tap call `runtime.dispatch(action)`; it runs the local steps and
  returns `{ reply?, url? }` for the host to send or open, as it would for a static button.
- Input `bind?: string` with `value?: string`: show `value` as the field's text and call
  `runtime.setInput(bind, text)` on every edit.
