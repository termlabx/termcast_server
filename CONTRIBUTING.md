# Contributing to Termcast Server

## Licensing, before anything else

This project is licensed under the [AGPL-3.0-or-later](LICENSE), and
contributions additionally require agreeing to the
[Contributor License Agreement](CLA.md).

The CLA grants ulixlab a parallel license to your contribution. In plain terms:
you keep the copyright to what you write, and ulixlab gains the right to ship
it under other terms as well — which is what makes the signed binary releases
and commercial licensing possible. Opening a pull request signifies your
agreement. A bot will confirm this on your first PR.

If your employer owns the IP you produce, get their sign-off before
contributing.

## Getting set up

Node.js 24 or newer is required — it is the floor declared in
`relay-server/package.json` and the release pipeline enforces it.

```bash
git clone https://github.com/termlabx/termcast_server.git
cd termcast_server/relay-server
npm install
npm run build
npm test
```

The test suite is self-contained. If `npm test` does not pass on a clean
checkout, that is a bug — please report it rather than working around it.

## Running the daemon during development

```bash
cd relay-server
npm run dev -- start        # tsx, no build step
```

You need the native terminal binaries present. Fetch prebuilt ones:

```bash
./scripts/fetch-ttyd-binaries.sh
./scripts/fetch-tmux-binaries.sh
```

## Tests

```bash
cd relay-server
npm test                    # unit suite + protocol vector check
npm run test:integration    # port-forwarding integration tests
```

Shell-level tests live in `scripts/`:

```bash
./scripts/termcast-loop.test.sh
./scripts/termcast-logrotate.test.sh
```

## Changing the wire protocol

`protocol-vectors/v1.json` is the contract between this daemon and the iOS and
Android clients. It is generated, never hand-edited.

**Never regenerate the vectors to make a failing test pass.** A vector
mismatch means an implementation diverged from the protocol; regenerating
hides that divergence and ships a client that cannot talk to the relay. Find
out which side is wrong first.

Legitimate protocol changes need a new version file (`v2.json`) and
coordinated updates to the mobile clients, which live in a separate
repository. Open an issue before starting one — a change here that the clients
cannot follow will not be merged.

```bash
cd relay-server
npm run vectors:check       # verify v1.json matches the code (CI runs this)
npm run vectors             # regenerate, only for a deliberate protocol change
```

## Code style

Match the surrounding code. The project uses TypeScript with strict settings,
ES modules, and Node's built-in test runner — no external test framework.
Comments explain *why*, not *what*.

## Pull requests

- One logical change per PR.
- Include tests for behavior changes.
- Make sure `npm test` passes before opening.
- Describe what breaks if the change is wrong. Reviewers use this.

## Security issues

Do not open a public issue for a vulnerability. Email the maintainer and allow
time for a fix before disclosure.

## What lives elsewhere

The iOS and Android apps, the Cloudflare relay service, and the release and
notarization pipeline are maintained in a separate private repository. Issues
about those belong here only insofar as they concern this daemon's behavior.
