// Entry point injected into discord.com (isolated world).
//
// IMPORTANT: window.indexedDB in a content script is the PAGE's IndexedDB
// (discord.com origin), completely separate from the extension's IndexedDB
// where background.js stores handshake keys. All key I/O is therefore routed
// through chrome.runtime.sendMessage so the background worker handles it.

// --- inline crypto helpers (no ES module imports in classic content scripts) ---

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function xorStream(msgBytes, keyBytes) {
  const out = new Uint8Array(msgBytes.length);
  for (let i = 0; i < msgBytes.length; i++) {
    out[i] = msgBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return out;
}

// --- key helpers (delegated to background service worker) ---

// Read-only lookup — returns token hex or null.
async function getKey(channelId, uidHash) {
  const resp = await chrome.runtime.sendMessage({ type: 'nocc-get-key', channel: channelId, uidHash });
  return resp?.token ?? null;
}

// Returns own key for (channelId, uidHash), creating one if absent.
async function getOrCreateOwnChannelKey(channelId, uidHash) {
  const resp = await chrome.runtime.sendMessage({ type: 'nocc-get-or-create-key', channel: channelId, uidHash });
  return resp?.token ?? null;
}

function getCurrentChannelId() {
  const parts = window.location.pathname.split('/');
  return parts[parts.length - 1] || null;
}

// Returns the SHA256 UID hash written by background.js after relay connect.
// Wakes the background if needed and waits up to 3 s.
async function getMyUidHash() {
  let { myUidHash } = await chrome.storage.local.get('myUidHash');
  if (myUidHash) return myUidHash;

  chrome.runtime.sendMessage({ type: 'nocc-wake' }).catch(() => {});
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    ({ myUidHash } = await chrome.storage.local.get('myUidHash'));
    if (myUidHash) return myUidHash;
  }
  return null;
}

// --- encryption request handler ---
// Format: nocc_{senderUidHash}_{hexCiphertext}
function listenForEncryptRequests() {
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'nocc-encrypt-request') return;

    const { id, content, channelId } = event.data;
    let encrypted = content;

    try {
      const myUidHash = await getMyUidHash();
      if (!myUidHash) throw new Error('uid hash not ready');

      const tokenHex = await getOrCreateOwnChannelKey(channelId, myUidHash);
      if (!tokenHex) throw new Error('could not get own key');

      const cipherHex = bytesToHex(xorStream(new TextEncoder().encode(content), hexToBytes(tokenHex)));
      encrypted = `nocc_${myUidHash}_${cipherHex}`;
    } catch (err) {
      console.warn('[nocc] encryption failed, forwarding plaintext:', err);
    }

    window.postMessage({ type: 'nocc-encrypt-response', id, encrypted }, '*');
  });
}

// --- message decryptor ---
// Watches the DOM for nocc_{64hexSenderUid}_{hexCipher} messages.
// If the sender's key is not on file, triggers a handshake and retries.
function setupMessageDecryptor() {
  const dec = new TextDecoder();
  const processing = new WeakSet();
  const pendingHandshake = new Set();

  let scheduledScan = false;
  function scheduleScan(delayMs) {
    if (scheduledScan) return;
    scheduledScan = true;
    setTimeout(() => { scheduledScan = false; scan(); }, delayMs);
  }

  async function tryDecrypt(el, channelId) {
    const text = el.textContent;
    const match = text.match(/^nocc_([0-9a-f]{64})_([0-9a-f]+)$/);
    if (!match) return;
    if (processing.has(el)) return;

    processing.add(el);
    try {
      const [, senderUidHash, cipherHex] = match;
      if (cipherHex.length % 2 !== 0) return;

      const tokenHex = await getKey(channelId, senderUidHash);

      if (!tokenHex) {
        const hsKey = `${channelId}:${senderUidHash}`;
        if (!pendingHandshake.has(hsKey)) {
          pendingHandshake.add(hsKey);
          console.log('[nocc] no key for sender, starting handshake with', senderUidHash.slice(0, 8));
          chrome.runtime.sendMessage({
            type: 'nocc-start-handshake',
            peerId: senderUidHash,
            channel: channelId,
          }).catch(() => {});
          scheduleScan(12000);
          setTimeout(() => pendingHandshake.delete(hsKey), 60000);
        }
        return;
      }

      const plain = dec.decode(xorStream(hexToBytes(cipherHex), hexToBytes(tokenHex)));
      if (el.textContent === text) el.textContent = plain;
    } catch (err) {
      console.warn('[nocc] decryption failed:', err);
    } finally {
      processing.delete(el);
    }
  }

  function scan() {
    const channelId = getCurrentChannelId();
    if (!channelId) return;

    document.querySelectorAll('[class*="markup"] > span, [class*="messageContent"]').forEach((el) => {
      if (el.textContent.startsWith('nocc_')) tryDecrypt(el, channelId);
    });
  }

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
}

// --- entry point ---

(async () => {
  const id = await window.NOCC.getOwnDiscordId();

  if (id) {
    console.log('[nocc] discord id:', id);
    chrome.storage.local.set({ discordUserId: id });
  } else {
    console.warn('[nocc] could not find a Discord user id (user_id_cache missing/unexpected shape)');
  }

  // Keep the background service worker alive while this tab is open so the
  // relay socket stays connected during multi-pass handshakes.
  chrome.runtime.connect({ name: 'nocc-keepalive' });

  listenForEncryptRequests();
  setupMessageDecryptor();
})();
