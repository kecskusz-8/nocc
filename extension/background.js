// Background service worker — auto-connects to the relay and handles
// handshake routing so content scripts don't need to manage sockets.
// Runs as an ES module (manifest.json: "type": "module").

import { connectToRelay } from './lib/relay-socket.js';
import { createHandshakeSession } from './crypto/three-pass.js';
import { saveKey, getKeysFor, getAllKeys } from './storage/key-store.js';
import { getMyId } from './discord/identity.js';

let socket = null;
let myUidHash = null;
const sessions = new Map();
let pendingConnection = null;
let reconnectTimer = null;

// --- session management (mirrors popup.js) ---

function getOrCreateSession(peerId, channel) {
  const key = `${peerId}:${channel}`;
  if (sessions.has(key)) return sessions.get(key);

  const session = createHandshakeSession({
    myId: myUidHash,
    peerId,
    channel,
    send: (payload) => socket.emit('handshake', payload),
    onLog: (msg) => console.log(`[nocc handshake ${peerId.slice(0, 8)}/${channel}]`, msg),
    onComplete: async ({ ownKey, peerKey }) => {
      console.log('[nocc] handshake complete with', peerId.slice(0, 8), 'in channel', channel);
      const createdAt = Date.now();
      await saveKey({ channel, uidHash: myUidHash, token: ownKey, createdAt });
      await saveKey({ channel, uidHash: peerId, token: peerKey, createdAt });
    },
  });

  sessions.set(key, session);
  return session;
}

// --- relay connection ---

function connect(onRegistered) {
  return new Promise(async (resolve) => {
    const stored = await chrome.storage.local.get(['relayUrl']);
    const relayUrl = stored.relayUrl || 'http://localhost:3000';

    if (socket) socket.close();
    socket = connectToRelay(relayUrl);

    socket.on('connect', async () => {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

      try {
        const config = await socket.emitWithAck('config', {});
        await chrome.storage.local.set({
          salt: config.salt || '',
          pepper: config.pepper || '',
        });
      } catch (_) {}

      const { id } = await getMyId();
      myUidHash = id;
      await chrome.storage.local.set({ myUidHash });

      socket.emit('register', { uid_hash: myUidHash });
      console.log('[nocc] registered as', myUidHash);

      onRegistered?.();
      resolve();
    });

    socket.on('handshake', (payload) => {
      if (!myUidHash) return;
      const session = getOrCreateSession(payload.sent_from, payload.channel);
      session.handleIncoming(payload);
    });

    socket.on('disconnect', () => {
      console.log('[nocc] relay disconnected — reconnecting in 5 s');
      myUidHash = null;
      chrome.storage.local.remove('myUidHash');
      sessions.clear();
      reconnectTimer = setTimeout(connect, 5000);
    });

    socket.on('error', () => console.warn('[nocc] relay connection error'));
  });
}

// Ensures the relay is connected and myUidHash is set.
// Handles the case where the service worker woke from dormancy with no socket.
async function ensureConnected() {
  if (socket && myUidHash) return;
  if (pendingConnection) return pendingConnection;
  pendingConnection = connect().finally(() => { pendingConnection = null; });
  return pendingConnection;
}

// --- message handler for content scripts ---
// All key I/O is routed through here because content scripts run in the page's
// JS context (discord.com origin) and cannot access the extension's IndexedDB.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'nocc-status') {
    sendResponse({ connected: !!(socket && myUidHash) });
    return;
  }

  if (msg.type === 'nocc-verify-peer') {
    (async () => {
      await ensureConnected();
      if (!socket) { sendResponse({ exists: false }); return; }
      try {
        const result = await socket.emitWithAck('verify', { uid_hash: msg.uidHash });
        sendResponse({ exists: result?.exists === true });
      } catch (_) {
        sendResponse({ exists: false });
      }
    })();
    return true;
  }

  if (msg.type === 'nocc-wake') {
    ensureConnected();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'nocc-get-key') {
    getKeysFor(msg.channel, msg.uidHash).then((keys) => {
      sendResponse({ token: keys[0]?.token ?? null });
    });
    return true;
  }

  if (msg.type === 'nocc-get-or-create-key') {
    (async () => {
      const keys = await getKeysFor(msg.channel, msg.uidHash);
      if (keys.length > 0) { sendResponse({ token: keys[0].token }); return; }

      const token = Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (b) => b.toString(16).padStart(2, '0')
      ).join('');
      await saveKey({ channel: msg.channel, uidHash: msg.uidHash, token, createdAt: Date.now() });
      sendResponse({ token });
    })();
    return true;
  }

  if (msg.type === 'nocc-start-handshake') {
    (async () => {
      await ensureConnected();
      if (!myUidHash) { sendResponse({ error: 'not connected' }); return; }

      // Skip if we already have the peer's key — both sides can race to trigger
      // a handshake and we only need one to win.
      const existing = await getKeysFor(msg.channel, msg.peerId);
      if (existing.length > 0) { sendResponse({ ok: true }); return; }

      const session = getOrCreateSession(msg.peerId, msg.channel);
      session.start(); // no-ops if session already in progress (guarded in three-pass.js)
      sendResponse({ ok: true });
    })();
    return true;
  }
});

// Keep the service worker alive while any Discord tab has the extension
// connected — prevents the relay socket from being killed mid-handshake.
chrome.runtime.onConnect.addListener((_port) => {
  // Holding a reference to the port keeps the SW alive until the tab closes.
});

// Auto-connect on startup.
connect();
