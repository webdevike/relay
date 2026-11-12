# Phone send: one tap delivered many times, laggy composer (2026-11-11)

## Symptom
- 2026-11-12 01:28Z: one chip, `[answer to: "Okay to remove both?"] Yes, remove both`, landed in Nova's thread 5 times (01:28:28, :32, :39, :42, :45; Nova's session jsonl `2026-11-11T08-30-20-026Z_01a1c9ba...`). Isaac counted 7.
- 2026-11-12 02:24Z: `Have fable 5.2 go through` landed 6 times, 2.5 to 12.7 s apart (02:24:44, :53, 02:25:01, :14, :16, :17).
- Isaac: "I hit send and it doesn't send, so I keep hitting it."

## Not the cause: wire duplicates
- The host dedupes `cmd` ids per device, in flight and after, across reconnects (`apps/linux/src/dedup.ts`, `session.ts` `handleCmd`). Each landing was its own `sendTurn` with its own command id: real taps.

## Causes (each one makes a sent turn look unsent)
1. **The JS thread is saturated while an assistant streams.** The host sends the whole thread on every change, debounced 150 ms (`SNAPSHOT_DEBOUNCE_MS`): all earlier transcripts plus the live session. Measured tonight from `~/.config/relay/assistants/nova.json`: 31 transcripts, 7,919 rows, 4.30 MB per frame. The phone's decode (`parseServerMessage`: JSON.parse + zod) of that frame under the Hermes VM from `react-native/sdks/hermesc` (Mac Mini): 216 to 246 ms per frame (JSON.parse alone 13 ms); Bun JIT 14 ms. A frame takes longer than the gap to the next, so from the moment a turn starts a reply the JS thread has no idle time: taps run seconds late, acks and pongs queue behind frames. It grew one transcript a night, so it got worse without one guilty commit.
2. **The echo vanished on any rev bump** (`settlePending`: `snapshot.rev > sinceRev` retired it). The host bumps rev on every streaming tick, ask change and status change, and a turn sent while the assistant works is a steer that joins the transcript only when omp takes it. So the bubble disappeared within 150 ms and nothing showed until the steer landed; chips under the newest reply came back (`liveReplies` saw no pending turn) and invited another tap.
3. **Timeouts reported delivered turns as failed.** Phone ack timeout 10 s for every command; the host's `turn()` can spend up to 30 s starting omp, and the bridge nacked a `reply` after 5 s although the frame was already in the live omp's socket. The phone then cleared the echo and put the draft back; the resend was a new command id, so it was delivered again.
4. **No send lock.** `sendTurn` had no in-flight guard and `ReplyChips` no chosen state. Taps queued during (1) each ran with the old rendered state and each sent.
5. Smaller: every `sendCommand` re-sent every unacked command (an image turn's base64 again on each later command); the open thread re-rendered on every status frame of any omp session (it selected the whole `sessions` record); rooms frames (whole rooms, up to 4 Hz) were decoded uncoalesced; AppState `inactive` (Face ID, Control Center) closed the socket; a reconnect made the field read-only mid-word.

Host log for the incidents is gone: a LaunchAgent `ai.eva.relay-host` owns port 7817 while the Relay Host.app menu-bar app relaunches its own `relay-host serve` about every 20 s, fails on the port, and truncates `~/Library/Logs/RelayHost.log` each time.

## Fixes (this change)
- Protocol: `assistant.get.rows`, `AssistantSnapshot.older`, `assistant.turn.clientId` (optional; older hosts strip them).
- Host: a socket that asks for `rows` gets only the newest rows, on the answer and every push (`tailSnapshot`); `AssistantService.turn` delivers a `clientId` once (in flight or done; a failed one can be retried); a bridge `reply` with no answer in time resolves (frame is with the live omp) and a later refusal is logged.
- Phone: asks for the newest 400 rows, a step more as the list pages up (Nova: 0.24 MB, 11 to 13 ms Hermes decode per frame instead of 230 ms); snapshots for threads not on screen are dropped before decoding; rooms frames coalesce; echoes are a list, each retired only by a new row of Isaac's newer than its send (or, acked with no row, once the thread is idle with something newer, or 30 s idle); the receipt reads Sending, then Sent once acked; a tap whose turn already shows sends nothing (store read, so queued taps see it); one `clientId` per message, reused after a timeout; turn ack timeout 45 s; chips lock and show the chosen one; `sendCommand` sends only its own command; running chips in their own component; `inactive` no longer closes the socket; the field stays editable offline; the call button is back in the header.
- Carried: the phone memory fix from `eva/phone-memory` (10333d60, fd92ef5f, 339241e8; TEMP memtest 4ce17302 dropped).

## Left
- The host still builds the whole thread every 150 ms before cutting it (host CPU, not the phone).
- An open ask whose bubble is older than the window shows as an inline card at the top of the loaded rows.
- A timeout still restores the draft (now safe to resend: same `clientId`).
- The duplicate host supervisors (LaunchAgent vs Relay Host.app) need Isaac's call.
