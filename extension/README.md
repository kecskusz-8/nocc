# NOCC Browser Extension

*This describes the current design, written before the code. Specifics may still change; see [Status](../README.md#status) in the main README.*

The part that actually lives in your browser: a pure JS content script that watches Discord's message box, encrypts what you type before it leaves your machine, and decrypts what shows up in the DOM before you ever read it.

No framework, no build tools, no bundler. Open any file in this folder and you're looking at exactly what runs in your browser. Nothing compiled, nothing minified, nothing hidden.

## What it does

- Injects into `discord.com` as a content script.
- Listens for the message-send event on Discord's input box and encrypts the plaintext (AES) using your own active key for that channel, before Discord's own send logic ever sees it.
- Watches the DOM for incoming messages, detects NOCC-encrypted payloads, and swaps the ciphertext for decrypted plaintext in place.
- Runs a three-pass key exchange with other NOCC users automatically over the relay, once per channel per key rotation. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) for the full protocol.
- Stores keys locally via IndexedDB, keyed by channel and owning user, with a timestamp used to age keys out on schedule (3 days active, 33 days total before deletion). Keys never leave your machine except masked under a one-time pad, during the handshake.

## Installation (loading unpacked)

There's no build step and nothing to install from a store yet. You load the folder directly.

### Chrome / Chromium / Brave / Edge

1. Clone this repo.
2. Go to `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked**, and select the `extension/` folder.
5. Open or reload Discord in a tab.

### Firefox

1. Clone this repo.
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on**, and select `extension/manifest.json`.
4. Open or reload Discord in a tab.

Note: Firefox's "temporary add-on" loading unloads the extension when the browser restarts. For a persistent install, you'll need to sign the extension via Mozilla's process, or reload it each session. This is a "fork it and run it yourself" project, not a polished store listing.

## How to use it

There's nothing to configure to get started. The extension ships pointed at a default community relay and starts working the moment it's loaded.

- **Key exchange** happens automatically the first time you message someone else running NOCC. The extension surfaces whether a handshake is pending or complete for a given conversation.
- **Encryption status** is shown per-conversation, so you can tell whether keys have been exchanged with the other party for the current DM/channel. If no key exchange has happened yet, messages go out as normal, unencrypted Discord messages.
- **Using a custom relay:** if you're self-hosting (see [`INSTALL.md`](../INSTALL.md)), open the extension's settings and set your relay's URL plus the `SALT`/`PEPPER` values matching your server. Everyone you want to talk to needs the same relay and the same salt/pepper.
- Messages sent to someone *not* running NOCC just go through as normal. NOCC only encrypts when both sides have it installed and have completed a handshake.

## Troubleshooting

**Messages showing as ciphertext / garbage text instead of decrypting:**
Discord shipped a DOM/markup change that broke the selector NOCC uses to find message content. This happens periodically since NOCC has no official integration with Discord and relies on reading their DOM. Check open issues, or open one with a screenshot of the DOM structure around a message (`Inspect Element` on a message bubble).

**Handshake stuck on "pending":**
The other user hasn't come online, isn't on the same relay, or your `SALT`/`PEPPER` values don't match theirs (if self-hosting). Hashes are salt/pepper-dependent, so mismatched values mean your hashed UIDs never line up, and neither side can find the other.

**No encryption indicator ever appears:**
Confirm both the extension and the relay are reachable. Open the browser console on a Discord tab and check for `NOCC:` prefixed log lines indicating connection errors.

**Extension stops working after a Discord update:**
Discord's frontend changes without warning and without a stable API for extensions like this. NOCC works by reading and writing Discord's DOM directly, so any structural change on their end can break it until the selectors are updated. This is an accepted tradeoff of not depending on Discord's cooperation. See [`ARCHITECTURE.md`](../ARCHITECTURE.md#design-decisions-and-tradeoffs).

## Manual build

There is none. Edit the JS files directly, reload the extension (`chrome://extensions`, then use the reload action for the extension, or reload the temporary add-on in Firefox), and refresh Discord.

## Browser compatibility

- **Manifest V3**, targeting current Chrome/Chromium-based browsers (Chrome, Brave, Edge, Opera) and current Firefox (which also supports MV3).
- Safari is not currently supported. Its extension APIs and content script model differ enough that it isn't a drop-in target. Contributions welcome.
- Mobile browsers are not supported. Discord's mobile apps don't support browser extensions at all.
