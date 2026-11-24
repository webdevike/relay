# Call me when it's done

Isaac tells an assistant "Nova, call me when the waterfall options are ready". The assistant registers that request; when the work settles, his iPhone rings ("Nova is calling"), and the call opens with "Hey Isaac, the thing you asked for is done: the waterfall options. Want any follow-ups?" From there it is a normal Relay voice call with that assistant.

Only Isaac's ask creates a request. Assistants never offer a call, never call on their own, and have no importance or duration triggers.

## How an assistant registers it

From its own omp session (the assistant prime tells it when):

```sh
RH="/Applications/Relay Host.app/Contents/MacOS/relay-host"
"$RH" call-me add --agent nova --about 'the waterfall options'     # prints call-<id>
"$RH" call-me list [--all]                                          # open requests (--all adds ended)
"$RH" call-me cancel --all --agent nova                             # "never mind the call"
"$RH" call-me settle <id> [--failed] --result '2 tests failed'      # only for --on manual
```

What the request waits on (`--on`), so "call me about this work you're doing" needs no question to Isaac:

| `--on` | Waits for | Settled when |
|---|---|---|
| absent, one agent-session run of the assistant running | that run (`work/eva/agent-sessions/<id>.json`) | its state is `done`, `failed`, `timeout` or `stopped` (read every `pollMs`) |
| absent, no run running | this turn: the calling session (else the assistant's own) | it stops working and none of its background jobs or subagents run |
| absent, several runs running | refused with the list; the assistant picks one (`--on run:<id or title words>`) | |
| `run:<ref>` / `session:<ref>` | that run / omp session (id, id prefix or title words) | as above |
| `manual` | something the host cannot see (CI, a remote job) | `call-me settle` |

Failed work rings too; the greeting then says it didn't finish and offers to look into it.

## What Isaac sees

- **Pending**: one work card in the assistant's thread, "Call you when done: the waterfall options", with a running timer (a `relay-guest` work row, `work.id` `call:<id>`; same row on the phone and the desktop, updated in place). No new rails, strips or header glyphs.
- **Ringing**: a Time Sensitive push "Nova is calling" with Nova's portrait (`mutableContent`, the notification service), body "The waterfall options: done. Tap to answer." Its data `{ id: "call:<id>", callRequest, agent, assistant: true }`. A tap opens Nova's thread and starts the PCM call with `call.start` + `request`, which the host answers with that request's greeting and a brief (what came back from the work) for the voice. The card reads "Calling you".
- **Answered**: the card ends "Called you about the waterfall options."
- **Missed** (no answer within `ringMs`): the ring is withdrawn, one push "Missed call from Nova" with the result, and the card ends "Missed call. The waterfall options: done. <result>". No retry loop.
- **Cancelled**: the card ends "Call cancelled"; a ringing push is withdrawn.
- **Expired** (work never settled within `maxWaitMs`): the card says so, no call.

Every push goes to every paired phone: Isaac asked for this call, so a per-assistant mute does not apply. The desktop shows the card; it does not ring (Relay desktop has no PCM call path).

Lifecycle: [`call-request` machine](../state-machines/call-request.md) (`apps/linux/src/callme/callRequest.machine.ts`), run by `CallMeService` (`callme/service.ts`). Requests survive a host restart (`~/.config/relay/call-requests.json`).

## Timing (host.json)

```json
{ "callMe": { "ringMs": 90000, "maxWaitMs": 86400000, "pollMs": 5000 } }
```

Defaults are `DEFAULT_CALL_ME_TIMING` in `callme/service.ts`: ring 90 s, give up after 24 h, read a run's record every 5 s.

## Engines

The tap always starts the PCM call (`call.start`), so the request works on a Deepgram host (Isaac's) with Deepgram's own greeting, and on a host whose PCM engine is unavailable with the local `VoiceCall` (it speaks the greeting first). GPT-Live's `live.start` is native Swift (`LiveCallEngine`) and does not carry `request`; a GPT-Live host serves an answered ring through its local call, or answers "This host cannot take calls" when it has no local speech stack.

## Native step: a real incoming call (CallKit), not shipped

What ships now is OTA-able: a high-priority notification that opens straight into the call. A real ringing phone (full-screen incoming-call UI on the lock screen, ringtone, answer with a swipe, the call in Recents) needs a new binary:

1. **PushKit VoIP pushes**: `PKPushRegistry` registration in native code (an Expo module or `expo-callkit-telecom`), its VoIP token sent to the host beside the Expo token, `UIBackgroundModes: voip`, and the APNs VoIP topic `com.ike.relay.voip`.
2. **CallKit**: since the iOS 13 SDK, every VoIP push must be reported to CallKit at once (`CXProvider.reportNewIncomingCall`), or iOS stops delivering them ([Apple: Responding to VoIP Notifications from PushKit](https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit)). Answer (`CXAnswerCallAction`) opens the audio session and starts the same `call.start` + `request` from native code (`LiveCallEngine` already owns a native call path), so it works from the lock screen without opening the app; Decline ends the request as cancelled.
3. **Host**: VoIP pushes go to APNs directly (HTTP/2, `apns-push-type: voip`, `apns-expiration: 0`, an APNs auth key under `secrets/`), because the Expo push service sends only regular notifications. `CallMeService.ring` sends the VoIP push instead of the Time Sensitive one when the phone registered a VoIP token; the missed-call push stays as is.

Until then the cost is one tap on a banner instead of a swipe on a ringing screen.
