# Contributing to NOCC

*This describes the current design, written before the code. Specifics may still change; see [Status](README.md#status) in the main README.*

NOCC is a small tool built by and for people who don't want their private conversations dragnet-scanned. Contributions are welcome: code, docs, bug reports, forks, all of it.

## Code of conduct

Be decent to other contributors. Full policy: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Short version: don't be a jerk, don't harass anyone, disagreements about code are fine, personal attacks aren't.

## Reporting issues

Open a GitHub issue. Include:
- What you expected to happen vs. what actually happened.
- Browser + version, and whether you're using the default relay or a self-hosted one.
- Console output if the extension is throwing errors (`NOCC:` prefixed log lines).

If it's a **security vulnerability** (key leakage, MITM opportunity, relay logging something it shouldn't), do not open a public issue. See [`SECURITY.md`](SECURITY.md) for responsible disclosure.

## Submitting pull requests

1. Fork the repo, branch off `main`.
2. Keep PRs focused. One fix or one feature per PR, not a grab bag.
3. Explain *why* in the PR description, not just what changed. "Fixes handshake race when both users connect simultaneously" beats "fix bug."
4. Test manually before submitting (see below). There's no CI pipeline running an automated suite against Discord's live DOM.
5. Open the PR against `main`.

## Coding standards

- **Plain JS. No frameworks, no TypeScript, no build step.** That's not a style preference, it's core to why this project exists. Anyone should be able to open a file and read exactly what runs, with nothing compiled in between.
- Keep functions small and readable over clever. This code needs to survive being read by a stranger at 2am trying to figure out if it's safe to trust.
- No unnecessary dependencies. The relay's dependency list should stay short; the extension's should stay at zero.
- Match the existing style in the file you're editing over imposing a new one.
- **Modularity**. seperate discord specific actions, so the project can be easily reused, or be a guideline for other platforms.

## Testing

There's no automated test suite. NOCC's surface area (Discord's live DOM, a WebSocket relay, browser extension APIs) doesn't lend itself well to one, and we'd rather ship simple, readable code than a mocked test harness pretending to cover it. Test manually:

1. Load the extension unpacked (see [`extension/README.md`](extension/README.md)).
2. Run the relay locally (see [`server/README.md`](server/README.md)).
3. Open two browser profiles (or one normal + one incognito/private window), each with the extension loaded and pointed at your local relay.
4. Log into Discord as two different accounts, DM between them, and confirm:
   - The handshake completes and the extension reflects that.
   - Messages sent from one side show as ciphertext in Discord's own UI if you inspect the raw message (proving encryption actually happened before sending).
   - Messages decrypt correctly on the receiving side.
5. If you touched relay code, confirm routing state clears when both sockets disconnect (no leftover room membership), and confirm the only thing that survives a relay restart is the `known_users` table, nothing else.

## Forks and modifications

Forking is not just tolerated, it's the point. NOCC is designed to be small and readable enough that adapting it, to another platform, another encryption scheme, another threat model, should be a weekend project, not an ordeal. If you build something on top of NOCC, we'd love to hear about it, but you don't owe us that; the license already guarantees your users the same freedoms.

## License agreement

By submitting a contribution, you agree it's licensed under GPLv3, same as the rest of the project. See [`LICENSE`](LICENSE). No CLA, no copyright assignment. Your code stays yours; it's just also free.
