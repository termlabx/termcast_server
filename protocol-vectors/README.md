# Protocol Vectors

Fixed, known-answer test data for the Termcast wire protocol. Every client
implementation asserts against **these same bytes**, so a port that diverges
fails at build time instead of on a user's phone.

## Why

The relay is spoken by three independent implementations — `relay-server`
(TypeScript/Node), `ttyd_mobile/` (Swift/CryptoKit), and `ttyd_android/`
(Kotlin, planned). Nothing in a single codebase's own tests can catch two
implementations agreeing with themselves but not with each other, and a crypto
mismatch does not present as a crypto error: it presents as a terminal that
shows nothing.

The specific hazard this exists for: **CryptoKit's `AES.GCM.SealedBox.combined`
is `nonce(12) ‖ ciphertext ‖ tag(16)`**, while Android's `javax.crypto` returns
`ciphertext ‖ tag` and carries the nonce separately. A port that assembles those
in the wrong order encrypts and decrypts perfectly against *itself*, and fails
only against the real relay.

## Files

- `v1.json` — the vectors. Generated; do not hand-edit.

## Generating

```bash
cd relay-server
npx tsx scripts/generate-protocol-vectors.ts          # rewrite v1.json
npx tsx scripts/generate-protocol-vectors.ts --check  # CI: fail if out of sync
```

Everything is deterministic — fixed keys, fixed nonces. A vector that changes
between runs is not a vector.

## The rule

**These bytes are the protocol.** Adding a vector is routine. *Changing* an
existing one is a breaking change to every already-paired device, and a test
failing against a vector means the code changed, not that the vector is stale.
Never regenerate to make a failure go away.

## What's covered

| Group | Pins |
|---|---|
| `kdf` | X25519 → HKDF-SHA256 (`salt=""`, `info="ttyd-relay-v1"`) → 32-byte AES key |
| `aeadDecrypt` | AES-256-GCM sealed boxes laid out `nonce(12) ‖ ct ‖ tag(16)`, incl. empty and multi-byte UTF-8 plaintexts |
| `pairingWrap` | Pairing-secret wrap: HKDF-SHA256 (`salt="termcast-pair-v1"`, `info="pairing-secret-wrap"`) |
| `clientFrames` | Outer client↔relay `[type:1][payload]` and inner termcast `[cmd:1][data]` byte layouts |

The `kdf` group uses **RFC 7748 §6.1**'s published scalars and answers, so it
anchors to an external standard rather than to our own output. Vectors generated
by the same code that verifies them cannot, on their own, catch a shared
misunderstanding of X25519.

## Consumers

| Implementation | Consumer | Status |
|---|---|---|
| `relay-server` (TS/Node) | `src/protocol-vectors.test.ts` | ✅ asserting |
| `ttyd_android/` (Kotlin) | `core/src/test/kotlin/com/termcast/core/RelayCryptoVectorsTest.kt`, `RelayFrameVectorsTest.kt` | ✅ asserting |
| `ttyd_mobile/` (Swift) | — | planned; would pin CryptoKit against the same bytes |

Run them with:

```bash
cd relay-server  && npm test                                  # Node consumer
cd ttyd_android  && ./gradlew :core:test --rerun-tasks        # Kotlin consumer
```

A port is wire-correct when its consumer passes. Kotlin and Node now both
decrypt each other's pinned sealed boxes and derive identical keys, which is the
property that matters — two implementations agreeing with each other, not each
agreeing with itself. Swift is still unverified against these bytes: iOS is the
implementation the vectors were reverse-engineered *from*, so it is very likely
correct, but "likely" is exactly what this file exists to replace.
