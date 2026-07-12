# NOCC Relay Server

*This describes the current design, written before the code. Specifics may still change; see [Status](../README.md#status) in the main README.*

The relay is the dumbest piece of this project that can still do its job.

It does two things: forward encrypted handshake payloads between two hashed user IDs, and keep a minimal record of which hashed UIDs have ever registered. It never sees a plaintext message, never sees a real key, never sees a real Discord user ID, and never sees an actual chat message (those go straight through Discord's own send pipeline, already encrypted, without passing through the relay at all).

## What it does

- Joins each connecting client to a Socket.io room named after its `uid_hash`. No separate routing table to maintain; forwarding a payload to `hash(X)` is just emitting into that room.
- Relays the passes of a three-pass key exchange (see [`ARCHITECTURE.md`](../ARCHITECTURE.md)) between two rooms, as opaque blobs it never inspects.
- On first registration, upserts the `uid_hash` into PostgreSQL so the relay (and, by extension, the extension) can tell whether a given hashed UID belongs to a NOCC user at all.

## What it doesn't do

- No message relaying. Chat messages never touch the relay; they travel through Discord's own infrastructure as ciphertext, decrypted client-side on arrival.
- No key storage. K1/K2 pass through in transit, masked under each user's own one-time pad, and are never written anywhere server-side.
- No connection logs, no last-seen timestamps, no record of who talked to whom. The database holds exactly one thing: `uid_hash` and when it was first seen.
- No authentication beyond "you know your own hashed UID." This is intentionally minimal. See [`SECURITY.md`](../SECURITY.md) for the threat model this is and isn't designed for.

## Installation

Requires Node.js 18+ and a reachable PostgreSQL instance.

```bash
cd server
npm install
```

Create the one table the relay needs:

```sql
CREATE TABLE known_users (
  uid_hash   TEXT PRIMARY KEY,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Running it

```bash
SALT=$(openssl rand -hex 32) \
DATABASE_URL=postgres://user:pass@localhost:5432/nocc \
node index.js
```

`SALT` and `DATABASE_URL` are both required. The process will refuse to start without them. `PORT` and `PEPPER` are optional.

## Configuration

All configuration is environment variables. No config file, no flags.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | Port the relay listens on |
| `SALT` | **yes** | none | Mixed into `SHA256(uid + SALT + PEPPER)` when hashing UIDs. Must be unique per deployment. Generate with `openssl rand -hex 32` |
| `PEPPER` | no | none | Optional second secret, kept separate from `SALT` (e.g. in a secrets manager rather than the `.env` file) for defense in depth |
| `DATABASE_URL` | **yes** | none | PostgreSQL connection string, e.g. `postgres://user:pass@host:5432/nocc` |

Note: the relay never generates or sees UID hashes itself. Hashing happens client-side in the extension, using the same `SALT`/`PEPPER` values you configure here. Every user connecting to your relay needs to be configured with matching values, or their hashes won't line up, and they won't find each other or match existing `known_users` rows.

## API reference (Socket.io events)

The relay speaks Socket.io, and deliberately has almost no API surface. Every pass of the key exchange, in both directions, rides the same generic event, since the relay's job is identical for all of them: forward the blob to the room named in `to`.

| Event | Direction | Payload | Purpose |
|---|---|---|---|
| `register` | client → server | `{ uid_hash }` | Joins the socket to a room named `uid_hash`, and upserts `uid_hash` into `known_users` |
| `verify` | client → server (ack) | `{ uid_hash }` → `{ exists }` | Checks whether a hashed UID belongs to a registered NOCC user, via a Socket.io acknowledgement callback rather than a broadcast event |
| `handshake` | client → server → client | `{ to: uid_hash, channel, pass: 1-3, data: <masked blob> }` | One pass of a three-pass key exchange. Used six times per rotation (three passes to deliver K1, three to deliver K2). Entirely opaque to the server. |
| `disconnect` | client → server | none | Socket.io removes the socket from its rooms automatically; no server code required |

See [`ARCHITECTURE.md`](../ARCHITECTURE.md) for the full handshake walkthrough and key lifecycle.

## Deployment

Short version: it's one Node process plus a small Postgres database, so deploy it however you'd deploy any small Node service with a managed or self-hosted Postgres instance alongside it. Full instructions, including Dockerfile, docker-compose (with Postgres), systemd unit, and Cloudflare Tunnel setup, are in [`DEPLOY.md`](../DEPLOY.md).

## Security considerations

- **The relay operator can see:** connection timing, IP addresses (unless you put it behind something that hides them), and which hashed UIDs are connecting. That's metadata. This is unavoidable for any relay-based system and is documented in full in [`SECURITY.md`](../SECURITY.md).
- **The relay operator cannot see:** message content, encryption keys, real Discord user IDs (only their salted/peppered hashes), or who is talking to whom, since the database doesn't record any relationship between two hashes, only their individual existence.
- **If the database is seized or compromised:** the attacker gets a flat list of hashed UIDs and first-seen timestamps. No keys, no messages, no conversation graph. That list is only useful to someone who already knows a target's real UID plus your `SALT`/`PEPPER` to compute the matching hash and confirm they've used this relay.
- **If a live connection is intercepted:** handshake payloads are already encrypted before they reach the relay, so interception without the recipient's decryption key yields nothing.
- Run your own relay if you don't want to trust someone else's. That's the whole point of self-hosting being a first-class option here, not an afterthought.

## Self-hosting guide

You need a machine that can run Node and stay reachable, plus a Postgres instance (local, managed, or containerized):

```bash
git clone https://github.com/nocc-project/nocc.git
cd nocc/server
npm install
SALT=$(openssl rand -hex 32) \
DATABASE_URL=postgres://user:pass@localhost:5432/nocc \
node index.js
```

Then give everyone who'll use your relay:
1. The relay's URL (`wss://your-domain:PORT`, or `ws://ip:PORT` only for local testing; use `wss://` for anything else, see [`DEPLOY.md`](../DEPLOY.md))
2. The exact `SALT`/`PEPPER` values you configured. They need matching values to hash UIDs the same way.

There's no admin panel and no user accounts to manage beyond the single `known_users` table. That table is the only state this project asks you to be responsible for.
