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

async function getKey(channelId, uidHash) {
  const resp = await chrome.runtime.sendMessage({ type: 'nocc-get-key', channel: channelId, uidHash });
  return resp?.token ?? null;
}

async function getOrCreateOwnChannelKey(channelId, uidHash) {
  const resp = await chrome.runtime.sendMessage({ type: 'nocc-get-or-create-key', channel: channelId, uidHash });
  return resp?.token ?? null;
}

async function verifyPeer(uidHash) {
  const resp = await chrome.runtime.sendMessage({ type: 'nocc-verify-peer', uidHash }).catch(() => null);
  return resp?.exists === true;
}

function getCurrentChannelId() {
  const parts = window.location.pathname.split('/');
  return parts[parts.length - 1] || null;
}

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

// --- toggle state bridge ---
// A hidden element lets page-inject.js (MAIN world) read the toggle state
// without requiring any message passing at send time.

function injectNoccState() {
  if (document.getElementById('nocc-state')) return;
  const el = document.createElement('div');
  el.id = 'nocc-state';
  el.dataset.encrypt = '1';
  el.style.display = 'none';
  document.documentElement.appendChild(el);
}

// --- NOCC peer cache ---
// channelId → Set<senderUidHash> for confirmed NOCC senders seen this session.
const channelNoccPeers = new Map();

// Own uid hash — populated at startup to filter our own messages from tryDecrypt.
let myOwnUidHash = null;

// --- UI injection ---

function updateNoccIcon(channelId) {
  const icon = document.getElementById('nocc-peer-icon');
  if (!icon) return;
  const active = (channelNoccPeers.get(channelId)?.size ?? 0) > 0;
  icon.style.color = active ? '#22c55e' : '#ef4444';
  icon.title = active ? 'NOCC peer active' : 'No NOCC peer detected';
}

function injectNoccUi(channelId) {
  try {
    // --- lock toggle ---
    const existingToggle = document.getElementById('nocc-toggle');
    if (existingToggle) existingToggle.remove();

    const stateEl = document.getElementById('nocc-state');
    const encryptOn = stateEl ? stateEl.dataset.encrypt !== '0' : true;

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'nocc-toggle';
    toggleBtn.textContent = encryptOn ? '🔒' : '🔓';
    toggleBtn.title = encryptOn ? 'NOCC encryption on' : 'NOCC encryption off';
    Object.assign(toggleBtn.style, {
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      fontSize: '18px',
      padding: '0 4px',
      opacity: encryptOn ? '1' : '0.45',
      lineHeight: '1',
      display: 'flex',
      alignItems: 'center',
    });

    toggleBtn.addEventListener('click', () => {
      const state = document.getElementById('nocc-state');
      if (!state) return;
      const nowOn = state.dataset.encrypt !== '1';
      state.dataset.encrypt = nowOn ? '1' : '0';
      toggleBtn.textContent = nowOn ? '🔒' : '🔓';
      toggleBtn.title = nowOn ? 'NOCC encryption on' : 'NOCC encryption off';
      toggleBtn.style.opacity = nowOn ? '1' : '0.45';
    });

    // Try to insert into the toolbar button row (emoji/gif icons area).
    const toolbar = document.querySelector('[class*="toolbar"]');
    if (toolbar) {
      toolbar.insertBefore(toggleBtn, toolbar.firstChild);
    } else {
      // Fallback: append to the bottom form area.
      const form = document.querySelector('form[class*="form"]');
      if (form) form.appendChild(toggleBtn);
    }
  } catch (_) {}

  try {
    // --- peer status icon ---
    const existingIcon = document.getElementById('nocc-peer-icon');
    if (existingIcon) existingIcon.remove();

    const dot = document.createElement('span');
    dot.id = 'nocc-peer-icon';
    dot.textContent = 'NOCC';
    Object.assign(dot.style, {
      fontSize: '11px',
      fontWeight: '700',
      letterSpacing: '0.06em',
      marginLeft: '8px',
      color: '#ef4444',
      transition: 'color 0.3s',
      userSelect: 'none',
      flexShrink: '0',
    });
    dot.title = 'No NOCC peer detected';

    // Target the channel header via its stable aria-label.
    const topBar = document.querySelector('[aria-label="Channel header"]');
    const titleEl = topBar && (
      topBar.querySelector('[class*="titleWrapper"]') ||
      topBar.querySelector('h1') ||
      topBar.querySelector('h2')
    );

    if (titleEl) {
      titleEl.appendChild(dot);
    } else if (topBar) {
      topBar.appendChild(dot);
    }

    updateNoccIcon(channelId);
  } catch (_) {}
}

// --- encryption request handler ---
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
function setupMessageDecryptor() {
  const dec = new TextDecoder();
  const processing = new WeakSet();
  const pendingHandshake = new Set();

  let lastPath = '';
  let scheduledScan = false;
  let pendingScan = false;

  function scheduleScan(delayMs) {
    if (scheduledScan) return;
    scheduledScan = true;
    setTimeout(() => { scheduledScan = false; scan(); }, delayMs);
  }

  // Debounced entry point for the MutationObserver so that bursts of DOM
  // mutations during Discord's React renders only trigger one scan per frame
  // instead of one per mutation (which would be hundreds per second).
  function queueScan() {
    if (pendingScan) return;
    pendingScan = true;
    setTimeout(() => { pendingScan = false; scan(); }, 50);
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

      const isOwnMessage = myOwnUidHash && senderUidHash === myOwnUidHash;

      const tokenHex = await getKey(channelId, senderUidHash);

      if (!tokenHex) {
        // Own messages with no key: nothing to decrypt or handshake about.
        if (isOwnMessage) return;

        const hsKey = `${channelId}:${senderUidHash}`;
        if (!pendingHandshake.has(hsKey)) {
          pendingHandshake.add(hsKey);

          const isNoccUser = await verifyPeer(senderUidHash);
          if (!isNoccUser) {
            console.log('[nocc] peer not registered, skipping handshake for', senderUidHash.slice(0, 8));
            return;
          }

          // Peer verified — light up the icon before the handshake completes.
          if (!channelNoccPeers.has(channelId)) channelNoccPeers.set(channelId, new Set());
          channelNoccPeers.get(channelId).add(senderUidHash);
          updateNoccIcon(channelId);

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

      // Peer messages only: verify with relay once per sender per session
      // before lighting the icon.
      if (!isOwnMessage && !(channelNoccPeers.get(channelId)?.has(senderUidHash))) {
        const isNoccUser = await verifyPeer(senderUidHash);
        if (isNoccUser) {
          if (!channelNoccPeers.has(channelId)) channelNoccPeers.set(channelId, new Set());
          channelNoccPeers.get(channelId).add(senderUidHash);
          updateNoccIcon(channelId);
        }
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

    // Detect channel navigation (Discord SPA) and re-inject UI.
    const newPath = window.location.pathname;
    if (newPath !== lastPath) {
      lastPath = newPath;
      // Wait a tick for Discord to render the new channel DOM before injecting.
      setTimeout(() => injectNoccUi(channelId), 300);
    } else if (!document.getElementById('nocc-toggle') || !document.getElementById('nocc-peer-icon')) {
      // Re-inject if React removed our elements. Safe here because queueScan's
      // 50ms debounce means our DOM mutations don't re-enter scan() immediately —
      // the next queued scan will see the elements present and stop.
      injectNoccUi(channelId);
    }

    document.querySelectorAll('[class*="markup"] > span, [class*="messageContent"]').forEach((el) => {
      if (el.textContent.startsWith('nocc_')) tryDecrypt(el, channelId);
    });
  }

  new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
  scan();
}

// --- entry point ---

(async () => {
  const id = await window.NOCC.getOwnDiscordId();

  if (id) {
    console.log('[nocc] discord id:', id);
    chrome.storage.local.set({ platformUserId: id });
  } else {
    console.warn('[nocc] could not find a Discord user id (user_id_cache missing/unexpected shape)');
  }

  // Keep the background service worker alive while this tab is open so the
  // relay socket stays connected during multi-pass handshakes.
  // Re-connect on bfcache restore (pageshow persisted) since all ports are
  // closed when a page enters the back/forward cache.
  function connectKeepalive() {
    const port = chrome.runtime.connect({ name: 'nocc-keepalive' });
    port.onDisconnect.addListener(() => {
      // Reading lastError suppresses the "Unchecked runtime.lastError" warning
      // that Brave/Chrome emits when the port closes due to bfcache entry.
      void chrome.runtime.lastError;
    });
  }
  connectKeepalive();
  window.addEventListener('pageshow', (e) => { if (e.persisted) connectKeepalive(); });

  // Resolve our own uid hash so tryDecrypt can skip our own messages.
  getMyUidHash().then((h) => { myOwnUidHash = h; });

  injectNoccState();
  listenForEncryptRequests();
  setupMessageDecryptor();

  // Initial UI injection (handles the case where the page was already on a channel).
  const channelId = getCurrentChannelId();
  if (channelId) setTimeout(() => injectNoccUi(channelId), 500);
})();
