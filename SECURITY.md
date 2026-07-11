# Security Policy

*This describes the current design, written before the code. Specifics may still change; the threat model is less likely to. See [Status](README.md#status) in the main README.*

NOCC exists to make one specific kind of surveillance harder: bulk, server-side scanning of message content, of the kind proposed under Chat Control-style legislation. Be honest with yourself about what that does and doesn't cover before you rely on it.

## Threat model

NOCC is designed against:

- **Client-side/server-side scanning mandates (Chat Control):** if a scanner sits on Discord's servers, or is bolted onto the client by legal mandate, and inspects message content, NOCC ensures there's no plaintext content to inspect by the time it gets there. Only AES ciphertext.
- **Passive network/server observation:** anyone reading Discord's database, logs, or network traffic sees ciphertext, not your conversation.
- **Relay operator snooping:** the relay only ever handles encrypted blobs and salted/peppered UID hashes. A relay operator (including a malicious one) cannot recover message content or real user identities from what passes through it.
- **Relay seizure:** the relay's database holds exactly one table: hashed UIDs and a first-seen timestamp. If it's seized, that's all there is to hand over. No message content, no keys, no message history, no record of who talked to whom.

NOCC is **not** designed against, and does not claim to protect against:

- **A compromised endpoint.** If your device (or the other party's) is compromised, NOCC can't help you. The attacker reads plaintext the same way you do.
- **Metadata.** Who you're talking to, when, how often, and roughly how much you're saying is visible to Discord regardless of NOCC, because the handshake and message relay still ride on Discord's infrastructure and your own relay's connection logs (to whatever extent your relay operator chooses to log connections; the reference relay doesn't, but nothing stops a fork from doing so). NOCC encrypts *content*, not the fact that a conversation is happening.
- **Discord's own logs and moderation systems.** Discord still sees connection metadata, account activity, and (for encrypted messages) an opaque ciphertext blob sent through its normal message pipeline. NOCC does not hide that you're using Discord, or that you're sending *something* to someone.
- **A targeted, resourced attacker with endpoint access** (device seizure, malware, coerced disclosure). NOCC protects against bulk/dragnet scanning, not against a targeted investigation with physical or remote access to a device.
- **Traffic analysis.** Message timing and size patterns are not obfuscated.
- **A malicious fork or a relay that logs everything.** NOCC's security model assumes the relay code you're running matches what's in this repo. Nothing stops someone from forking it, adding logging, and calling it NOCC. Verify what you're actually running, especially if you're not self-hosting.

## What is protected

- Message content, once both sides have completed the key exchange.
- The K1/K2 key material exchanged during the handshake (masked under each user's own one-time pad before it ever touches the relay; the relay only ever sees XOR-masked blobs it has no way to unwrap).
- Real Discord user IDs (the relay and database only ever see `SHA256(uid + SALT + PEPPER)`, never the raw ID).

## What is not protected

- Metadata: who's talking to whom, connection timing, approximate message frequency/size.
- Anything visible to Discord's own client/server before NOCC intercepts it, or after it's decrypted back into the DOM.
- Users who haven't installed NOCC. Messages to/from them are unencrypted, same as always.
- Anything on a compromised device.

## Responsible disclosure

If you find a vulnerability, a way to recover keys, MITM a handshake, deanonymize a UID hash, or make the relay log/leak something it shouldn't, please don't open a public GitHub issue first.

**Report it privately:** open a [GitHub Security Advisory](../../security/advisories/new) on this repo, or email the maintainers (see repo contact info). Include:
- A description of the issue and its impact.
- Steps to reproduce.
- Any suggested fix, if you have one.

We'll acknowledge reports as promptly as a volunteer-run project can, and credit you in the fix (unless you'd rather stay anonymous, your call). There's no bug bounty. This is a political project with no budget, not a company.

## Known limitations

- **Bounded, not perfect, forward secrecy.** Keys rotate every 3 days and are deleted entirely after 33 days, so a compromised key only exposes messages from within its own active window, not a conversation's full history. It is not per-message ratcheting: a key compromised while still active exposes everything encrypted under it during that window, and archived (non-active) keys sitting in IndexedDB for up to 33 days are themselves a real target if a device is compromised during that period.
- **A persistent, if minimal, database.** The relay keeps a durable table of hashed UIDs that use the extension. This is intentionally the smallest thing that could work (no timestamps beyond first-seen, no connection history, no social graph), but it is a permanent record, and it's a thing to weigh if your threat model includes the relay's database being seized or subpoenaed. 
##
- No protection against a malicious or compromised relay operator observing connection metadata (timing, IP, who's connecting to whom). Only message content, key material, and the identity graph between hashes are protected from the relay.
- Extension security depends on Discord's DOM structure not being adversarially manipulated by Discord itself; NOCC trusts the page it's injected into to the extent any content script must.
- Built and tested for small groups (well under 10 concurrent users per relay). It has not been hardened or audited for larger-scale or adversarial-scale deployment.
