// Background service worker — auto-connects to the relay and handles
// handshake routing so content scripts don't need to manage sockets.
// Runs as an ES module (manifest.json: "type": "module").

import { connectToRelay } from './lib/relay-socket.js';
import { createHandshakeSession } from './crypto/three-pass.js';
import { saveKey, getKeysFor, getAllKeys, saveSigningKey, getSigningKey } from './storage/key-store.js';
import { getMyId } from './identity.js';
import { bytesToHex, hexToBytes } from './crypto/random.js';

let socket = null;
let myUidHash = null;
const sessions = new Map();
let pendingConnection = null;
let reconnectTimer = null;

let signingPrivKey = null;
let signingPubKeyHex = null;

async function ensureSigningKeyPair() {
  if (signingPrivKey) return;
  const stored = await chrome.storage.local.get(['signingPrivKeyJwk', 'signingPubKeyHex']);
  if (stored.signingPrivKeyJwk && stored.signingPubKeyHex) {
    signingPrivKey = await crypto.subtle.importKey('jwk', stored.signingPrivKeyJwk, { name: 'Ed25519' }, false, ['sign']);
    signingPubKeyHex = stored.signingPubKeyHex;
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    signingPubKeyHex = bytesToHex(pubRaw);
    await chrome.storage.local.set({ signingPrivKeyJwk: privJwk, signingPubKeyHex });
    signingPrivKey = kp.privateKey;
  }
}

// --- session management (mirrors popup.js) ---

async function getOrCreateSession(peerId, channel) {
  const key = `${peerId}:${channel}`;
  if (sessions.has(key)) return sessions.get(key);

  // On the very first handshake with this peer (no peer key stored yet), reuse
  // the own-channel key that was already created to encrypt our first message.
  // The 3-pass exchange will deliver that key to the peer so they can decrypt
  // even that first message retroactively. On key rotation (peer key exists),
  // fall through to randomBytes so we get fresh key material.
  let providedOwnKey = null;
  const peerKeys = await getKeysFor(channel, peerId);
  if (peerKeys.length === 0) {
    const ownKeys = await getKeysFor(channel, myUidHash);
    providedOwnKey = ownKeys[0]?.token ?? null;
  }

  const session = createHandshakeSession({
    myId: myUidHash,
    peerId,
    channel,
    providedOwnKey,
    mySigningPubKeyHex: signingPubKeyHex,
    send: (payload) => socket.emit('handshake', payload),
    onLog: (msg) => console.log(`[nocc handshake ${peerId.slice(0, 8)}/${channel}]`, msg),
    onComplete: async ({ ownKey, peerKey, peerSigningPubKey }) => {
      console.log('[nocc] handshake complete with', peerId.slice(0, 8), 'in channel', channel);
      const createdAt = Date.now();
      // Skip re-saving our own key when we used the pre-existing one — it's
      // already in the DB and saving again would create a harmless duplicate.
      if (!providedOwnKey) {
        await saveKey({ channel, uidHash: myUidHash, token: ownKey, createdAt });
      }
      await saveKey({ channel, uidHash: peerId, token: peerKey, createdAt });
      if (peerSigningPubKey) await saveSigningKey(peerId, peerSigningPubKey);

      // Tell every open Discord tab to re-scan — messages that arrived before
      // the handshake (e.g. from an offline peer) can now be decrypted.
      const note = { type: 'nocc-handshake-complete', channel, peerId };
      for (const port of activePorts) {
        try { port.postMessage(note); } catch (_) {}
      }
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
        await chrome.storage.local.set({ salt: config.salt || '' });
      } catch (_) {}

      const { id } = await getMyId();
      myUidHash = id;
      await chrome.storage.local.set({ myUidHash });
      await ensureSigningKeyPair();

      socket.emit('register', { uid_hash: myUidHash });
      console.log('[nocc] registered as', myUidHash);

      onRegistered?.();
      resolve();
    });

    socket.on('handshake', async (payload) => {
      if (!myUidHash) return;
      const session = await getOrCreateSession(payload.sent_from, payload.channel);
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

  if (msg.type === 'nocc-sign') {
    (async () => {
      await ensureSigningKeyPair();
      const data = new TextEncoder().encode(msg.data);
      const sig = await crypto.subtle.sign({ name: 'Ed25519' }, signingPrivKey, data);
      sendResponse({ sig: bytesToHex(new Uint8Array(sig)) });
    })();
    return true;
  }

  if (msg.type === 'nocc-get-signing-pubkey') {
    (async () => {
      const pubKeyHex = await getSigningKey(msg.uidHash);
      sendResponse({ pubKeyHex });
    })();
    return true;
  }

  if (msg.type === 'nocc-resolve-embed') {
    (async () => {
      const ALLOWED = ['tenor.com', 'www.tenor.com', 'c.tenor.com', 'giphy.com', 'www.giphy.com', 'media.giphy.com'];
      try {
        const host = new URL(msg.url).hostname;
        if (!ALLOWED.includes(host)) { sendResponse(null); return; }
        const res = await fetch(msg.url, { headers: { Accept: 'text/html' } });
        if (!res.ok) { sendResponse(null); return; }
        const html = await res.text();

        function metaContent(property) {
          return (
            html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] ||
            html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, 'i'))?.[1] ||
            null
          );
        }

        sendResponse({
          imageUrl: metaContent('og:image') || metaContent('twitter:image') || null,
          videoUrl: metaContent('og:video') || metaContent('og:video:url') || null,
        });
      } catch (_) {
        sendResponse(null);
      }
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

      const session = await getOrCreateSession(msg.peerId, msg.channel);
      session.start(); // no-ops if session already in progress (guarded in three-pass.js)
      sendResponse({ ok: true });
    })();
    return true;
  }
});

// Keep the service worker alive while any Discord tab has the extension
// connected — prevents the relay socket from being killed mid-handshake.
// Active ports are also used to notify tabs when a handshake completes so
// they can re-scan messages that arrived before the key exchange finished.
const activePorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  activePorts.add(port);
  port.onDisconnect.addListener(() => {
    // Reading lastError suppresses the "Unchecked runtime.lastError" warning
    // that fires when the port closes because the page entered bfcache.
    void chrome.runtime.lastError;
    activePorts.delete(port);
  });
});

// Auto-connect on startup.
connect();
