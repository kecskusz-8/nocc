// Entry point injected into discord.com (isolated world). Extracts the user's
// own Discord ID and handles encryption requests from page-inject.js (MAIN
// world) via postMessage — only this side has access to IndexedDB.

// --- inline helpers (ES module imports not available in classic content scripts) ---

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

// XOR with a cycling key so messages longer than the key are still covered.
function xorStream(msgBytes, keyBytes) {
  const out = new Uint8Array(msgBytes.length);
  for (let i = 0; i < msgBytes.length; i++) {
    out[i] = msgBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return out;
}

// Returns the most recent own-key token hex for (channelId, discordUserId).
// Creates and persists a fresh 32-byte random key if none exists yet.
async function getOrCreateOwnChannelKey(channelId, discordUserId) {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open('nocc', 1);

    openReq.onupgradeneeded = () => {
      const store = openReq.result.createObjectStore('keys', { keyPath: 'id', autoIncrement: true });
      store.createIndex('by_channel_user', ['channel', 'uidHash']);
    };

    openReq.onerror = () => reject(openReq.error);

    openReq.onsuccess = () => {
      const db = openReq.result;
      const readTx = db.transaction('keys', 'readonly');
      const getReq = readTx.objectStore('keys').index('by_channel_user').getAll([channelId, discordUserId]);

      getReq.onerror = () => reject(getReq.error);
      getReq.onsuccess = () => {
        const records = getReq.result.sort((a, b) => b.createdAt - a.createdAt);
        if (records.length > 0) {
          resolve(records[0].token);
          return;
        }

        // No key yet — generate, persist, return.
        const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
        const writeTx = db.transaction('keys', 'readwrite');
        const addReq = writeTx.objectStore('keys').add({
          channel: channelId,
          uidHash: discordUserId,
          token,
          createdAt: Date.now(),
        });
        addReq.onerror = () => reject(addReq.error);
        addReq.onsuccess = () => resolve(token);
      };
    };
  });
}

function getCurrentChannelId() {
  const parts = window.location.pathname.split('/');
  return parts[parts.length - 1] || null;
}

// --- encryption request handler ---
// page-inject.js (MAIN world, document_start) intercepts fetch/XHR and asks
// us to encrypt via postMessage, since only the isolated world has IndexedDB.
function listenForEncryptRequests(discordUserId) {
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'nocc-encrypt-request') return;

    const { id, content, channelId } = event.data;
    let encrypted = content;

    try {
      const tokenHex = await getOrCreateOwnChannelKey(channelId, discordUserId);
      encrypted = 'nocc_' + bytesToHex(xorStream(new TextEncoder().encode(content), hexToBytes(tokenHex)));
    } catch (err) {
      console.warn('[nocc] encryption failed, forwarding plaintext:', err);
    }

    window.postMessage({ type: 'nocc-encrypt-response', id, encrypted }, '*');
  });
}

// --- message decryptor ---
// Watches the DOM for rendered messages that start with nocc_ and replaces
// their visible text with the decrypted plaintext.
function setupMessageDecryptor(discordUserId) {
  const dec = new TextDecoder();
  // Tracks elements mid-decrypt to avoid parallel calls on the same node.
  const processing = new WeakSet();

  async function tryDecrypt(el, channelId) {
    const cipher = el.textContent;
    if (!cipher.startsWith('nocc_')) return;
    if (processing.has(el)) return;

    processing.add(el);
    try {
      const cipherHex = cipher.slice(5);
      // Hex must be even-length and only hex chars — skip malformed strings.
      if (cipherHex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(cipherHex)) return;

      const tokenHex = await getOrCreateOwnChannelKey(channelId, discordUserId);
      const plain = dec.decode(xorStream(hexToBytes(cipherHex), hexToBytes(tokenHex)));

      // Guard: skip if Discord re-rendered the element while we were awaiting.
      if (el.textContent === cipher) el.textContent = plain;
    } catch (err) {
      console.warn('[nocc] decryption failed:', err);
    } finally {
      processing.delete(el);
    }
  }

  function scan() {
    const channelId = getCurrentChannelId();
    if (!channelId) return;

    // Target the innermost content containers Discord uses for message text.
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
    listenForEncryptRequests(id);
    setupMessageDecryptor(id);
  } else {
    console.warn('[nocc] could not find a Discord user id (user_id_cache missing/unexpected shape)');
  }
})();
