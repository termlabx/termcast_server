# Relay Server — Core Traffic Logic

## Overview

The desktop relay server bridges an iOS terminal client to a local `ttyd` process via a Cloudflare Workers relay. All terminal data is end-to-end encrypted — the relay sees only opaque ciphertext.

```
iOS App ⟷ Cloudflare Relay ⟷ Desktop Server ⟷ Local ttyd (127.0.0.1:7681)
          (untrusted)          (bridge.ts)       (shell process)
```

## Components

| File | Role |
|------|------|
| `index.ts` | Orchestrator — init, registration, lifecycle |
| `relay-client.ts` | WebSocket connection to Cloudflare relay |
| `bridge.ts` | Handshake, encryption, message bridging |
| `crypto.ts` | X25519 ECDH + ChaCha20-Poly1305 |
| `ttyd-manager.ts` | Spawns and manages local ttyd process |
| `pairing.ts` | QR code generation with pairing info |
| `web-ui.ts` | Local HTTP server to display QR code |

## Startup Sequence

```
index.ts
  ├─ TtydManager.start()         → spawn ttyd on 127.0.0.1:7681
  ├─ generateKeyPair()           → X25519 server keypair
  ├─ createPairingInfo()         → deviceId + pairingSecret + serverPublicKey
  ├─ POST /api/register          → register device with Cloudflare relay
  ├─ WebUI.start()               → serve QR code on localhost:8080
  ├─ RelayClient.connect()       → open WebSocket to relay as "server" side
  └─ Bridge.start()              → connect to local ttyd, begin message forwarding
```

## Wire Protocol

All messages are binary: `[1-byte type][payload]`

| Type | Code | Direction | Purpose |
|------|------|-----------|---------|
| HANDSHAKE | `0x01` | client → server | Client sends ephemeral public key |
| HANDSHAKE_ACK | `0x02` | server → client | Server confirms key exchange |
| DATA | `0x03` | both | Encrypted terminal data |
| ERROR | `0x04` | server → client | Error notification |
| PING | `0x05` | both | Keepalive ping |
| PONG | `0x06` | both | Keepalive pong |
| SERVER_OFFLINE | `0x07` | relay → client | Server disconnected |
| CLIENT_OFFLINE | `0x08` | relay → server | Client disconnected |

## Connection & Handshake Flow

### 1. Registration (index.ts)

```
Desktop                          Cloudflare Relay
   │                                  │
   │  POST /api/register              │
   │  { device_id, pairing_secret }   │
   │─────────────────────────────────►│
   │                                  │  hash(pairing_secret) → store
   │  { ok: true }                    │
   │◄─────────────────────────────────│
   │                                  │
   │  WS /api/connect/server          │
   │     ?device_id=X                 │
   │─────────────────────────────────►│
   │         (persistent WebSocket)   │
```

### 2. iOS Client Connects

```
iOS App                     Cloudflare Relay              Desktop Server
   │                             │                             │
   │  (scan QR code)             │                             │
   │  WS /api/connect/client     │                             │
   │  ?device_id&pairing_secret  │                             │
   │────────────────────────────►│                             │
   │                             │  verify(pairing_secret)     │
   │                             │  HANDSHAKE_ACK →            │
   │                             │  { client_connected }       │
   │                             │────────────────────────────►│
   │                             │                             │  (relay-client.ts emits
   │                             │                             │   'client_connected')
```

### 3. E2E Key Exchange (bridge.ts)

```
iOS App                     Cloudflare Relay              Desktop Server
   │                             │                             │
   │  0x01 HANDSHAKE             │                             │
   │  { client_public_key }      │                             │
   │────────────────────────────►│────────────────────────────►│
   │                             │                             │
   │                             │                  bridge.ts: │
   │                             │    shared = X25519(         │
   │                             │      server_private_key,    │
   │                             │      client_public_key)     │
   │                             │    symKey = HKDF(shared)    │
   │                             │                             │
   │                             │  0x02 HANDSHAKE_ACK         │
   │                             │  { status: 'ok' }           │
   │                             │◄────────────────────────────│
   │◄────────────────────────────│                             │
   │                             │                             │
   │  iOS derives same symKey:   │                             │
   │  shared = X25519(           │                             │
   │    client_private_key,      │                             │
   │    server_public_key)       │                             │
   │  symKey = HKDF(shared)      │                             │
   │                             │                             │
   ╔═════════════════════════════╧═════════════════════════════╗
   ║  E2E encryption active — relay sees only ciphertext      ║
   ╚═════════════════════════════╤═════════════════════════════╝
```

### 4. Terminal Data Flow (bridge.ts)

**User types on iPhone:**

```
iOS App                     Cloudflare Relay              Desktop Server
   │                             │                             │
   │  0x03 DATA                  │                             │
   │  [encrypted user input]     │                             │
   │────────────────────────────►│────────────────────────────►│
   │                             │                             │
   │                             │                  bridge.ts: │
   │                             │    plaintext = decrypt(     │
   │                             │      payload, symKey)       │
   │                             │    ttydWs.send(plaintext)   │
   │                             │           │                 │
   │                             │           ▼                 │
   │                             │     ttyd (127.0.0.1:7681)   │
   │                             │     executes in shell       │
   │                             │           │                 │
   │                             │           ▼                 │
   │                             │    output = ttydWs.recv()   │
   │                             │    encrypted = encrypt(     │
   │                             │      output, symKey)        │
   │                             │                             │
   │  0x03 DATA                  │  0x03 DATA                  │
   │  [encrypted shell output]   │  [encrypted shell output]   │
   │◄────────────────────────────│◄────────────────────────────│
   │                             │                             │
   │  decrypt → render in        │                             │
   │  xterm.js terminal          │                             │
```

## Encryption Details (crypto.ts)

### Key Exchange
- **Algorithm**: X25519 Elliptic Curve Diffie-Hellman
- Server keypair generated at startup; public key embedded in QR code
- Client generates ephemeral keypair per session
- Both sides derive identical shared secret independently

### Key Derivation
- **Algorithm**: HKDF-SHA256
- Salt: empty
- Info: `"ttyd-relay-v1"`
- Output: 32-byte symmetric key

### Data Encryption
- **Algorithm**: ChaCha20-Poly1305 (AEAD)
- 12-byte random nonce per message (prevents replay)
- 16-byte authentication tag (prevents tampering)
- Message format: `[12B nonce][ciphertext][16B tag]`

## Reconnection & Error Handling

### relay-client.ts
- Reconnects to Cloudflare relay with exponential backoff (1s → 30s max)
- Heartbeat ping every 30 seconds keeps connection alive
- Emits `client_offline` when iOS client disconnects

### bridge.ts
- Reconnects to local ttyd every 2 seconds if connection drops
- On new client handshake: derives fresh symmetric key
- On `client_offline`: logs disconnect, ttyd connection stays alive

### ttyd-manager.ts
- Graceful shutdown via SIGTERM
- Process exit detection with error logging

## Security Boundaries

1. **QR Pairing**: Out-of-band key exchange (camera scan) — prevents MITM
2. **Pairing Secret**: PBKDF2-hashed on relay — relay never sees plaintext
3. **E2E Encryption**: Relay only forwards opaque ciphertext
4. **Localhost ttyd**: Bound to 127.0.0.1 — no network exposure
