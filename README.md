# Termcast Server

The macOS and Linux side of [Termcast](https://github.com/termlabx/termcast_server) —
a daemon that exposes your terminal to the Termcast mobile apps over an
end-to-end encrypted relay.

Terminal data is encrypted on your machine and decrypted on your phone. The
relay in between forwards ciphertext and never holds a key capable of reading
it.

```
Phone  ⟷  Cloudflare Relay  ⟷  termcast (this repo)  ⟷  local shell
             (untrusted)          your machine
```

## What is in this repository

| Directory | What it is |
|---|---|
| `relay-server/` | `termcast` — the daemon. Manages the local terminal, speaks the relay protocol, does the crypto. |
| `relay-desktop/` | The macOS menu-bar app that supervises the daemon. Electron. |
| `protocol-vectors/` | Known-answer test vectors pinning the wire protocol across implementations. |
| `scripts/` | Build the bundled native binaries (ttyd, tmux) from source, or fetch prebuilt ones. |

The mobile apps and the relay service itself are not part of this repository.

## Install

```bash
curl -fsSL https://termcast.download.ulixlab.com/install.sh | bash
termcast start
```

Then scan the QR code with the Termcast app.

## Build from source

Requires Node.js 24 or newer.

```bash
git clone https://github.com/termlabx/termcast_server.git
cd termcast_server

# The daemon
cd relay-server && npm install && npm run build && npm test

# The native terminal binaries — fetch prebuilt:
../scripts/fetch-ttyd-binaries.sh
../scripts/fetch-tmux-binaries.sh

# ...or compile them yourself (macOS):
../scripts/build-ttyd-arm64.sh
../scripts/build-tmux-arm64.sh
```

Run the daemon straight from the checkout:

```bash
cd relay-server && npm run dev -- start
```

### The desktop app

```bash
cd relay-desktop && npm install && npm run build
npm start                    # run it
npx electron-builder --mac   # package an unsigned .app
```

Producing a *signed and notarized* build requires your own Apple Developer ID.
Set `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_SPECIFIC_PASSWORD` in your
environment before packaging. The maintainer's signing pipeline is not part of
this repository, and the credentials in it are not either.

## Commands

```
termcast start                 start the daemon and show the pairing QR
termcast status                connection and session state
termcast qr                    reprint the pairing QR
termcast connect               connect to another Termcast machine
termcast forward <port>        forward a local port to paired devices
termcast forwards              list active forwards
termcast mesh                  server-to-server mesh controls
termcast leave                 leave the current cluster
termcast upgrade               update to the latest release
```

## Protocol

`protocol-vectors/v1.json` is the wire contract. Three independent
implementations — TypeScript here, Swift on iOS, Kotlin on Android — assert
against the same bytes, so a port that diverges fails at build time rather
than on a user's phone.

The specific hazard it exists for: CryptoKit's `AES.GCM.SealedBox.combined` is
`nonce ‖ ciphertext ‖ tag`, while Android's `javax.crypto` returns
`ciphertext ‖ tag` with the nonce carried separately. An implementation that
assembles those in the wrong order encrypts and decrypts perfectly against
itself and fails only against the real relay — presenting not as a crypto
error but as a terminal that shows nothing.

Do not hand-edit `v1.json`. It is generated:

```bash
cd relay-server && npm run vectors        # regenerate
cd relay-server && npm run vectors:check  # verify in sync (runs in CI)
```

See `relay-server/ARCHITECTURE.md` for the traffic path and
`protocol-vectors/README.md` for the vector format.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions require agreeing to the
[Contributor License Agreement](CLA.md).

## License

[GNU Affero General Public License v3.0 or later](LICENSE).

This is a strong copyleft license. You may use, study, modify and redistribute
this software freely. If you distribute a modified version — **or run one as a
network service** — you must make the complete corresponding source of your
modified version available under the same license. That network clause is the
reason this project uses the AGPL rather than the GPL.

See [NOTICE](NOTICE) for third-party components and copyright.

Commercial licensing that removes the AGPL obligations is available separately
from ulixlab.
