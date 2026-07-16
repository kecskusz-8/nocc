# Architecture

*This describes the current design, written before the code. Specifics may still change; the core architecture is less likely to. See [Status](README.md#status) in the main README.*

Technical deep-dive into how NOCC actually works. If you just want to use it, see [`INSTALL.md`](INSTALL.md). If you want to hack on it, start here.

## Overview

 ![alt text](./image.png)

The relay only ever routes small encrypted handshake payloads between two hashed IDs, and keeps a minimal Postgres record of which hashed IDs have ever registered. It never touches the chat platform's infrastructure directly, and it never sees an actual chat message. The platform carries whatever ciphertext the extension hands it, same as any other message.

## The handshake, in detail

Before two users can exchange encrypted messages in a given channel, they need to trade keys, without ever relying on a pre-shared secret or a certificate authority. NOCC does this with an **ephemeral ECDH P-256 key exchange**: both sides generate a fresh key pair for each handshake, derive a shared secret from the DH operation, then use that secret (stretched through HKDF-SHA-256) to wrap and deliver each other's per-channel message keys under AES-256-GCM. Neither side needs a pre-existing shared secret, a certificate, or any out-of-band setup.

Each key belongs to exactly one user in exactly one channel. K1 encrypts only U1's messages in this channel; K2 encrypts only U2's messages in this channel. Both keys are exchanged in a single three-pass handshake — half the wire cost of the previous six-pass approach. All three passes travel over a single opaque `handshake` event; the relay forwards whatever payload arrives to the room matching its `to` field and never inspects `data` or `pass`, but does two things beyond blind forwarding: it drops the pass entirely if the sending socket never registered, and it stamps a `sent_from` field onto the outgoing payload with the sender's own registered hash, overwriting anything the client put there.

**Simultaneous-start race**
Either side can initiate a handshake at any time. If both send a pass 1 before receiving the other's, the side with the lexicographically lower uid hash stays as initiator; the other side discards its in-flight pass 1 and drops into the responder role.

**Pass 1 — initiator → responder**
```
65 B  raw uncompressed P-256 public key (0x04 || x || y)
32 B  Ed25519 signing public key
```
The initiator generates a fresh ephemeral ECDH key pair and sends both the ECDH public key and their long-lived Ed25519 signing public key. The initiator is now waiting for pass 2.

**Pass 2 — responder → initiator**
```
65 B  raw uncompressed P-256 public key
32 B  Ed25519 signing public key
60 B  AES-256-GCM(wrapKey, K2)
```
The responder generates its own ephemeral ECDH key pair, performs ECDH against the initiator's public key, and derives the wrap key:
```
wrapKey = HKDF-SHA-256(shared_secret, salt=channelId, info="nocc-key-wrap")
```
K2 (the responder's own 32-byte message key for this channel) is encrypted with AES-256-GCM under `wrapKey` and appended to the payload. The responder now holds `wrapKey` and is waiting for pass 3.

**Pass 3 — initiator → responder**
```
60 B  AES-256-GCM(wrapKey, K1)
```
The initiator derives the same `wrapKey` from the DH operation with the responder's public key (ECDH is commutative — both sides compute the same shared secret). It decrypts K2 from pass 2, then encrypts K1 (its own message key for this channel) and sends it. The initiator calls the handshake complete.

The responder decrypts K1 from pass 3 and also calls the handshake complete.

At the end of the exchange, both sides hold both K1 and K2 plus each other's Ed25519 signing public key. K1 and K2 are used one-directionally: U1's messages are always encrypted with K1 and decrypted by whoever holds K1; U2's messages are always encrypted with K2 and decrypted by whoever holds K2. Compromising one user's key doesn't expose the other user's messages, and the relay never saw a plaintext key at any point — only AES-GCM ciphertexts it has no key to open.

**Ed25519 signing keys**
Each client generates a long-lived Ed25519 key pair once and persists it in `chrome.storage.local`. The public key is piggybacked onto passes 1 and 2 so both parties learn each other's signing key at no extra round-trip cost. After the handshake the peer signing public key is stored in IndexedDB (`signing-keys` store, keyed by uid hash) and used to verify signed payloads sent by that peer.

## Key lifecycle: rotation and history

Keys aren't permanent. Each per-(user, channel) key is generated fresh and:

- Is the **active** key for **3 days** from creation, used to encrypt that user's new outgoing messages in that channel.
- After 3 days, it stops being used for new messages (a new handshake generates and exchanges a replacement), but is kept as a **history** key for a further **30 days** (33 days total from creation) so older messages in that channel remain readable.
- After 33 days, the key and its timestamp are deleted from IndexedDB. Any message still encrypted under it becomes permanently unreadable at that point.

This periodic rotation means a key compromised today cannot decrypt messages sent under a different key generated three-plus days later, and it bounds how far back a compromised key can reach into history to 33 days. It is not full per-message forward secrecy (a compromised active key still exposes everything encrypted under it during its 3-day active window), but it meaningfully limits the blast radius compared to a single static key used forever. See [`SECURITY.md`](SECURITY.md#known-limitations) for the honest limits of this.

## Encryption flow (message → encrypt → send → decrypt)

1. You type a message into the platform's input box, normally.
2. The platform hook's content script listens for the send event (intercepting before the platform's own submit handler completes).
3. If you have an active key for this channel (handshake already completed, key still inside its 3-day active window), the plaintext is encrypted with AES-256-GCM using that key, and the ciphertext (base64/hex-encoded) is substituted as the actual message body the platform sends.
4. The platform's servers receive, store, and deliver the ciphertext exactly like any other message. They have no idea it's encrypted; it's just a string to them.
5. On the recipient's side, the hook recognizes NOCC ciphertext (a recognizable payload marker/prefix), looks up the sender's key for that channel in IndexedDB (active or archived, whichever covers the message's timestamp), decrypts it, and substitutes the plaintext client-side, after the platform has already rendered its version.
6. If no key exists yet for this sender/channel (no handshake completed, or the relevant key already aged out past 33 days), the message is shown as-is: plaintext goes out unencrypted if you have no active key, and old ciphertext that's aged out simply can't be decrypted anymore.

## UID hashing

Real platform user IDs never touch the relay or the database. Before registering with the relay or addressing a handshake to someone, the extension computes:

```
uid_hash = SHA256(uid + SALT + PEPPER)
```

- `SALT` is a shared secret configured per-relay-deployment. Everyone using the same relay needs the same `SALT` so their hashes are computed identically and can find each other.
- `PEPPER` is optional and deliberately kept separate from `SALT` (e.g. not stored in the same config file/secrets store), a second layer that, even if `SALT` leaks, still needs to be known separately to recompute valid hashes.
- This isn't meant to be unbreakable cryptographic anonymity. Someone who already knows a target's real UID can compute the same hash if they also know `SALT`/`PEPPER`. It's meant to keep the relay operator, and anyone observing relay traffic or the database, from casually reading off who's talking to whom without already having that information.

## Relay server internals

The relay is a single Node.js process running Socket.io, plus a thin PostgreSQL connection for one thing only: remembering which hashed UIDs have registered.

Routing needs no separate bookkeeping. On `register`, the server does two things:

```js
socket.join(uid_hash);
await db.query(
  'INSERT INTO known_users (uid_hash) VALUES ($1) ON CONFLICT DO NOTHING',
  [uid_hash]
);
```

From then on, forwarding a handshake payload is just:

```js
io.to(payload.to).emit(event, payload);
```

Socket.io's own room membership does the work a manual `Map` used to do. When a socket disconnects, Socket.io removes it from its rooms automatically, no cleanup code required.

The `known_users` table is the only thing that survives a restart. It has exactly one column: `uid_hash`. No per-connection logs, no timestamps, no record of who talked to whom. It answers exactly one question: has this hashed UID ever registered with this relay? Nothing else.

**Rate limiting**

The relay enforces limits at two levels:

*IP-level (server-wide)*
- **Connection cap:** max 10 concurrent sockets per source IP. An 11th connection attempt is immediately disconnected.
- **Registration cap:** max 2 distinct `uid_hash` values per IP per 10-minute window. Re-registration of the same uid hash (e.g. a reconnect) does not consume a slot. This limits how many separate identities a single IP can introduce in a short period without blocking normal reconnects.

*Per-socket (rolling 60-second windows)*
| Event | Max calls / 60 s |
|-------|-----------------|
| `register` | 5 |
| `handshake` | 100 |
| `verify` | 20 |

Calls that exceed the per-socket limits are silently dropped (or return an error for `verify`, which uses an ack callback). There is no IP-level block list; limits reset automatically when the window rolls over.

## Extension internals

No platform hook currently ships in `extension/`. The relay, crypto, and key-storage core documented above is platform-agnostic and unaffected; only the piece that reads/writes a specific chat platform's DOM and network traffic is missing. (The project previously had a platform-specific hook here; it's retired from the working tree and archived at git tag `archive/legacy-hook` for anyone who wants to recover it, but this doc no longer describes it since it isn't the project's current architecture.)

- **Key storage:** keys live in IndexedDB, not `chrome.storage.local`, since each channel can accumulate many keys over time (one active plus up to ten archived per user, given the 3-day/33-day cycle) and IndexedDB handles that volume and querying by timestamp far better. Each record is keyed by channel and owning user, and stores the key material plus its creation timestamp. A periodic cleanup pass deletes anything past the 33-day mark. This part is already implemented (`extension/storage/key-store.js`) and any future hook uses it as-is.
- **Signing key storage:** each client has one long-lived Ed25519 key pair. The private key JWK is stored in `chrome.storage.local` (extension-internal, never sent anywhere). The public key (hex) is kept in the same storage object so it can be quickly read at connect time and piggybacked onto handshake passes. Peer signing public keys (learned during handshake) are stored in a separate IndexedDB object store (`signing-keys`, keyed by `uid_hash`).
- **No official API/bot usage, by design:** whatever hook gets built is expected to read/write the same DOM and network calls the platform's own web client itself produces, rather than going through an official bot/OAuth API. This is why any hook is inherently fragile to the target platform's frontend changes, but also why it requires no API key, no bot approval, and no cooperation from the platform whatsoever.

## Design decisions and tradeoffs

- **DOM/network scraping instead of an official API/bot:** the tradeoff is fragility (the platform can break a hook with any frontend change) in exchange for zero dependency on that platform's cooperation, approval, or awareness that NOCC exists. Given the adversarial premise of this project, depending on a surveilled platform's blessing was never on the table.
- **A minimal database instead of zero database:** early versions of this project aimed for a fully stateless relay. In practice, being able to tell whether a given hashed UID belongs to a NOCC user at all (for example, before attempting a handshake) needs *some* durable record. The compromise is a single table holding nothing but hashed UIDs: enough to answer "is this person using NOCC," nothing that reveals conversations, timing, or content. See [`SECURITY.md`](SECURITY.md) for what that tradeoff means if the database is ever seized.
- **Per-sender, per-channel keys over one combined shared secret:** each user's messages in a channel are independently encrypted and independently readable. This avoids a single derived secret becoming a single point of compromise for both directions of a conversation, and it's what makes the 3-day/33-day rotation cycle meaningful. One side rotating out an old key doesn't require re-synchronizing a jointly derived value.
- **ECDH P-256 + HKDF + AES-GCM for key delivery over pre-shared secrets or PKI:** ephemeral ECDH means neither side needs a pre-existing shared secret, a certificate, or any out-of-band setup beyond knowing the other person's hashed UID. The wrap key is derived fresh every handshake (HKDF over the DH output, salted with the channel ID), so a compromised wrap key from one rotation reveals nothing about past or future ones. Three passes deliver both per-user channel keys and both signing public keys simultaneously, with the relay never seeing any plaintext key material.
- **Room-based routing over an explicit map:** naming Socket.io rooms after `uid_hash` values removes an entire class of bookkeeping code (and the bugs that come with keeping a hand-rolled map in sync with actual socket lifecycles). Socket.io already guarantees room cleanup on disconnect.
- **No build tooling:** slows down potential feature velocity in exchange for making the entire codebase auditable by a stranger in one sitting, and trivially forkable without fighting someone else's toolchain choices.
- **Small-scale by design:** NOCC is built for a friend group or a single server/community's worth of people, not for scaling to millions. There's no horizontal scaling, no load balancing, no sharding, because that's not the problem this project is trying to solve. See [`DEPLOY.md`](DEPLOY.md#scaling-considerations).

- **NOCC IS NOT A SELFBOT**
NOCC simplifies encrypting messages which users could do anyways.
Essentially, it could be considered a translator.

## Future considerations

- **A platform hook:** the handshake protocol and relay are already platform-agnostic — they just forward encrypted blobs between hashed IDs — but no hook currently exists in the working tree (see [Extension internals](#extension-internals)). Building one is mostly a matter of writing a content script for the target platform's DOM/network traffic, not touching the relay or handshake logic at all.
- **Shorter rotation windows / true per-message ratcheting:** the current 3-day rotation bounds exposure but is coarse. A Double-Ratchet-style scheme would shrink that window to roughly one key per message, at the cost of real complexity in an otherwise deliberately simple codebase.
- **Group conversations:** the current handshake is pairwise (2 users). A channel with more than two participants currently means each pair of members independently handshakes and exchanges their per-channel keys with each other. Extending this to a proper group broadcast (one key announcement reaching every current member at once) is a natural fork/contribution target.
