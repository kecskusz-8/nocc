# Writing a NOCC Hook

A hook is a platform-specific adapter that connects a chat platform to NOCC's encryption core. The core (key exchange, AES-GCM crypto, relay communication) is entirely platform-agnostic and lives in `extension/background.js`. A hook's only job is to intercept messages going in and out of one specific platform and call the right background APIs.

Note: most platforms could consider this as client modification, which can go against their ToS. implement at your own risk

---

## Folder structure

```
extension/hooks/
  <platform>/
    hook.json       ← required: declares URL patterns and scripts
    content.js      ← required: the isolated-world content script
    <other files>   ← any other file you need for DOM injection, data retrieval etc.
```

Drop the folder in. Open the popup, and it will auto-discover the folder, register the hook, and show it in the loaded hooks list. No other file needs to be touched.

---

## hook.json

Declares how the browser should inject your scripts.

### Simple (single content script, isolated world)

```json
{
  "name": "My Platform",
  "host_permissions": ["https://myplatform.com/*"],
  "matches": ["https://myplatform.com/*"],
  "content_scripts": ["content.js"]
}
```

`host_permissions` is informational — it documents what URLs the hook targets. The extension already has `<all_urls>` permission, so no manifest change is needed.

### Multi-registration (different worlds or run_at values)

Use this when you need a MAIN-world script:

```json
{
  "name": "My Platform",
  "host_permissions": ["https://myplatform.com/*"],
  "registrations": [
    {
      "matches": ["https://myplatform.com/*"],
      "js": ["page-inject.js"],
      "runAt": "document_start",
      "world": "MAIN"
    },
    {
      "matches": ["https://myplatform.com/*"],
      "js": ["get-user-id.js", "content.js"]
    }
  ]
}
```

`runAt` defaults to `document_idle`. `world` defaults to `ISOLATED`. Scripts listed in `js` are injected in order.

---

## What a hook must do

### 1. Set the user's platform ID

Tell NOCC who the current user is. Background will hash it into a `uid_hash` for the relay.

```js
chrome.storage.local.set({ platformUserId: '<the-platforms-own-user-id>' });
```

Do this as early as possible. If the ID is only available asynchronously (e.g. loaded from localStorage after login), retry with a small delay.

### 2. Keep the service worker alive

Open a long-lived port immediately. This prevents the background service worker from going dormant during a handshake. The port also delivers `nocc-handshake-complete` notifications so you can re-scan messages that arrived before key exchange finished.

```js
const port = chrome.runtime.connect({ name: 'nocc-platform' });
port.onMessage.addListener((msg) => {
  if (msg.type === 'nocc-handshake-complete') scanMessages();
});

// Handle bfcache: ports close when a page enters the back/forward cache.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) connectKeepalive(); // reconnect
});
```

### 3. Wake the service worker on load

```js
chrome.runtime.sendMessage({ type: 'nocc-wake' });
```

### 4. Intercept outgoing messages

Before the platform sends a message, encrypt the plaintext:

```js
const { ciphertext, error } = await chrome.runtime.sendMessage({
  type: 'nocc-encrypt',
  plaintext: 'Hello!',
  channel: '<channel-id>',
});

if (error) {
  // No active key yet — send plaintext, or show the user a warning.
  return;
}
// ciphertext is now: NOCC:<your-uid-hash>:<hex>
// Substitute it into the platform's send path.
```

### 5. Scan for incoming encrypted messages

Walk the DOM for nodes whose text starts with `NOCC:` and decrypt them:

```js
const { plaintext, peerId } = await chrome.runtime.sendMessage({
  type: 'nocc-decrypt',
  ciphertext: node.textContent,  // the full NOCC:... string
  channel: '<channel-id>',
});

if (plaintext === null) {
  // No key yet for this sender. Trigger a handshake:
  await chrome.runtime.sendMessage({
    type: 'nocc-start-handshake',
    peerId,     // returned even when plaintext is null
    channel: '<channel-id>',
  });
  // Schedule a re-scan after the handshake completes.
} else {
  node.textContent = plaintext;
}
```

Use a `MutationObserver` to re-scan whenever new message nodes appear (platforms re-render the message list as you scroll).

---

## Message API reference

All calls go through `chrome.runtime.sendMessage`. All are async (return a Promise).

| Message | Payload | Response | Notes |
|---------|---------|----------|-------|
| `nocc-wake` | — | `{ ok }` | Wakes the service worker. Call on content script load. |
| `nocc-status` | — | `{ connected }` | Is the relay socket connected? |
| `nocc-encrypt` | `{ plaintext, channel }` | `{ ciphertext }` or `{ error }` | Returns `NOCC:<uid>:<hex>`. Error if no active key yet. |
| `nocc-decrypt` | `{ ciphertext, channel }` | `{ plaintext, peerId }` | `plaintext` is null if no key. `peerId` is always the sender's uid_hash. |
| `nocc-start-handshake` | `{ peerId, channel }` | `{ ok }` | Initiates 3-pass ECDH exchange with `peerId`. No-ops if already in progress or key exists. |
| `nocc-verify-peer` | `{ uidHash }` | `{ exists }` | Checks the relay: has this uid_hash ever registered? Use to avoid handshaking with non-NOCC users. |
| `nocc-sign` | `{ data }` | `{ sig }` | Signs `data` (string) with your Ed25519 key. Hex-encoded. |
| `nocc-get-signing-pubkey` | `{ uidHash }` | `{ pubKeyHex }` | Returns a peer's Ed25519 public key (learned during handshake), or null. |
| `nocc-resolve-embed` | `{ url }` | `{ imageUrl, videoUrl }` | Fetches OG metadata for a Tenor/Giphy URL. Useful for rendering GIFs in decrypted messages. |

---

## Ciphertext format

`NOCC:<senderUidHash>:<cipherHex>`

- `senderUidHash` — 64 hex chars. SHA-256 of `(platformUserId + salt)`. Embedded by `nocc-encrypt` automatically so receivers know which key to use.
- `cipherHex` — AES-256-GCM output as hex. The first 24 chars are the 12-byte IV; the rest is ciphertext + authentication tag.

Detect NOCC messages by checking `text.startsWith('NOCC:')` or matching `/^NOCC:[0-9a-f]{64}:[0-9a-f]+$/`.

---

## Getting the channel ID

The channel ID is the identifier NOCC uses to scope keys to a conversation. It just needs to be unique per conversation — the relay never sees it.

For most platforms, a good channel ID is whatever the platform calls a channel, DM, or conversation ID. Pull it from the URL, the DOM, or the platform's internal state. Whatever you use, be consistent: both sides of a conversation must derive the same string for decryption to work.

---

## Getting the peer's UID hash

`nocc-decrypt` returns `peerId` automatically (parsed from the `NOCC:` prefix). You don't need to compute peer uid_hashes yourself for decryption.

For triggering `nocc-start-handshake` proactively (before you've seen a NOCC message from the peer), you'd need their uid_hash. That requires knowing their platform user ID and asking the background to hash it — which isn't currently a built-in message. In practice, just let `nocc-decrypt` returning `null` trigger the handshake reactively.

---

## Example skeleton

`extension/hooks/example/` is a minimal, heavily-commented starting point. Copy it, rename the folder, fill in the TODOs, open the popup.
