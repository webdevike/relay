# Transport

One `RelayServer` per Mac process: an `NWListener` advertised over Bonjour (`_relay._tcp`) that
accepts WebSocket connections and hands each one a `ClientSession`.

Connection flow: `hello` -> known device gets `challenge`/`auth` (HMAC proof), unknown device gets
`unpaired` -> `pair.request`/`pair.confirm` (PIN shown via `PairingUI`) -> `pair.ok` + `welcome`.
Once authenticated, `input` is forwarded live (dropped, never queued), `cmd` is deduped by id per
device across reconnects, and `agents.*`/`agent.*` state topics carry a monotonic `rev`.

Queue boundary: every `ClientSession` mutation, every `NWListener`/`NWConnection` handler, and
every `AgentProvider.onChange` callback runs on one serial `DispatchQueue` owned by `RelayServer`.
`ClientSession` never touches a socket directly; it only calls `FrameSink.send`, which the server
wires to the connection.

V1 security tradeoff: plaintext LAN, no TLS. Trust comes from HMAC-SHA256 auth using a 32-byte
secret exchanged once, in the clear, at `pair.ok`; acceptable on a trusted home LAN, not a public
network. A later version should add TLS with a pinned self-signed cert.
