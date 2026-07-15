# NOCC: No Chat Control

**End-to-end encryption for chat platforms.**

Pure JS browser extension + a dumb WebSocket relay. No keys touch the server.

*This is a living design doc written before the code. Specifics can change; the core architecture probably won't. See [Status](#status).*

---

## Why this exists

The EU is pushing "Chat Control," legislation that would force platforms to scan every private message, photo, and file you send, before encryption, in the name of catching criminals. In practice it means mass surveillance of everyone, forever, with no warrant and no suspicion required. It has been rejected, revised, and resurrected more times than anyone can count.

NOCC doesn't lobby, doesn't petition, and doesn't wait for politicians to do the right thing. It encrypts your chat messages **before they leave your browser**, so there's nothing readable left for a scanner (client-side, server-side, or government-mandated) to scan. The platform sees ciphertext. Chat Control sees ciphertext. Only the person you're talking to sees your actual words.

Use it, fork it, break it, improve it, hand it to a friend.

## Features

- **Real E2EE on top of an existing chat platform.** Messages are encrypted client-side with AES before they ever hit the platform's servers, via a per-platform "hook" (see [Status](#status) — no hook currently ships).
- **Pure JS, zero build step.** No webpack, no bundler, no `npm run build`. Open the folder, read the code, load it as-is.
- **Dumb relay, not a server.** The WebSocket relay only ever sees masked key material and hashed user IDs, and never sees a chat message at all. The only thing it stores is a single table of hashed UIDs, so it can tell whether a hash belongs to a NOCC user.
- **Self-hostable in minutes.** Don't trust the default relay? Run your own. It's one Node process plus a small Postgres database.
- **Works out of the box.** The extension ships pointed at a default community relay, so you're encrypted from install, no config required. Swap in your own relay whenever you want more control.
- **Small by design.** Built for a friend group or a server of a handful of people, not millions of users. See [Design Principles](#design-principles).

## How it works

NOCC's relay never sees a key in the clear and never sees a chat message at all. It just shuffles masked blobs between two hashed IDs. Getting one key (say, U1's) from U1 to U2 uses a three-pass exchange (Shamir's protocol), so neither side needs a pre-shared secret:

```
Pass 1  U1 -> [relay] -> U2      U1 sends E1(K1)
Pass 2  U2 -> [relay] -> U1      U2 sends E2(E1(K1))
Pass 3  U1 -> [relay] -> U2      U1 sends E2(K1); U2 unwraps it to get K1
```

U2's own key, K2, makes the same three-pass trip in the other direction. Once both sides hold K1 and K2, U1's messages are always encrypted with K1 and U2's messages are always encrypted with K2, applied before a message is sent through the platform's normal input, and decrypted client-side the moment it arrives. The platform's servers, logs, and any scanner sitting on top of them only ever see ciphertext.

User IDs are never sent in the clear either. The extension hashes them (`SHA256(uid + salt + pepper)`) before anything reaches the relay, so even the relay operator can't map a socket back to a real account without already knowing who they're looking for.

Full technical breakdown, including the key rotation schedule: [`ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Installation

### For users

1. Clone or download this repo.
2. Load the extension unpacked ([full instructions](extension/README.md)).
3. NOCC currently ships with no active platform hook (see [Status](#status)) — the extension's relay/crypto/key-storage core works, but a hook for your chat platform of choice needs to be built or restored first.

Full walkthrough: [`INSTALL.md`](docs/INSTALL.md).

### Self-hosting the relay

Don't want to trust the default relay? Run your own. It's one Node process plus a small Postgres database holding a single table:

```bash
git clone https://github.com/nocc-project/nocc.git
cd nocc/server
npm install
SALT=$(openssl rand -hex 32) \
DATABASE_URL=postgres://user:pass@localhost:5432/nocc \
node index.js
```

Then point your extension at it. Full server docs: [`server/README.md`](server/README.md). Full deployment guide (Docker, systemd, Cloudflare Tunnel): [`DEPLOY.md`](docs/DEPLOY.md).

## Configuration

The relay server is configured entirely with environment variables. No config files:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | Port the relay listens on |
| `SALT` | **yes** | none | Mixed into every UID hash. Generate one, keep it secret, never reuse it across deployments |
| `PEPPER` | no | none | Optional second secret mixed into UID hashes, kept out of the codebase/config entirely |
| `DATABASE_URL` | **yes** | none | PostgreSQL connection string. The only thing stored is a table of hashed UIDs |

The extension needs no configuration to work; it ships pointed at a default relay. If you're self-hosting, set the relay URL once in the extension's settings.

## Build instructions

just
```bash
npm i
```

That's it. NOCC is pure JS. No TypeScript, no bundler, no framework, no build step, on either the extension or the server. Clone it, edit it, reload it. That's the whole toolchain, and it's intentional: anyone should be able to read the entire codebase in an afternoon and fork it without fighting a build pipeline.

## Status

This whole doc suite was written before a line of implementation exists. It's the ideology and the architecture laid out up front, on purpose, so the *why* and the shape of the thing are locked in before anyone starts coding.

**Platform hook status:** the original platform-specific hook has been retired from the working tree and is archived at the git tag `archive/legacy-hook` (`git tag -l`, then check out that tag into a scratch dir to recover it). No platform hook currently ships in `extension/`; a generalized hook framework (with a new reference implementation) is planned. The relay, crypto, and key-storage core described below is unaffected and platform-agnostic already.

Two things follow from that:

- **Anything here can change.** Env var names, event names, exact schemas, exact numbers (3 days, 33 days, table columns, socket event shapes), all of it is current best thinking, not a frozen spec. Where the code and these docs disagree in the future, the code wins, and the docs should get updated to match.
- **The core architecture is the part least likely to move.** Client-side encryption before the platform ever sees plaintext, a relay kept as dumb as it can be, no config required to get started: that's the actual point of the project, and everything else described here is in service of it.

Treat this as a manifesto with implementation notes attached, not a contract.

## License

GPLv3. See [`LICENSE`](LICENSE). Copyleft, on purpose: if you improve NOCC and ship it, your users get the same freedoms you did.

## Contributing

Short version: open an issue, open a PR, keep it simple. Full guide: [`CONTRIBUTING.md`](docs/CONTRIBUTING.md).

## Security

Found a vulnerability? Please read [`SECURITY.md`](docs/SECURITY.md) before you post it publicly.

## Acknowledgments

To everyone who's ever run a relay, filed an issue, or forked this into something better: thank you. NOCC exists because surveillance legislation doesn't get to be the last word on how people are allowed to talk to each other.

