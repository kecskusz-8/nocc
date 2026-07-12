import { connectToRelay } from './lib/relay-socket.js';
import { createHandshakeSession } from './crypto/three-pass.js';
import { saveKey, getAllKeys } from './storage/key-store.js';
import { getMyId } from './discord/identity.js';

function logLine(text) {
  const log = document.getElementById('log');
  const line = document.createElement('div');
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

let socket = null;
let myId = null;

// Sessions are keyed by "peerId:channel" so each (peer, channel) pair runs
// its own independent handshake, per ARCHITECTURE.md's per-channel keys.
const sessions = new Map();

function getOrCreateSession(peerId, channel) {
  const key = `${peerId}:${channel}`;
  let session = sessions.get(key);
  if (!session) {
    session = createHandshakeSession({
      myId,
      peerId,
      channel,
      send: (payload) => socket.emit('handshake', payload),
      onLog: (msg) => logLine(`[${peerId.slice(0, 8)}/${channel}] ${msg}`),
      onComplete: async ({ ownKey, peerKey }) => {
        logLine(`[${peerId.slice(0, 8)}/${channel}] HANDSHAKE COMPLETE`);
        logLine(`  our key:  ${ownKey}`);
        logLine(`  their key: ${peerKey}`);

        const createdAt = Date.now();
        await saveKey({ channel, uidHash: myId, token: ownKey, createdAt });
        await saveKey({ channel, uidHash: peerId, token: peerKey, createdAt });
        logLine(`[${peerId.slice(0, 8)}/${channel}] stored both keys in IndexedDB`);
      },
    });
    sessions.set(key, session);
  }
  return session;
}

async function refreshMyId() {
  const salt = document.getElementById('salt').value;
  const pepper = document.getElementById('pepper').value;
  await chrome.storage.local.set({ salt, pepper });

  const { id, source } = await getMyId();
  myId = id;
  document.getElementById('myId').value = myId;
  document.getElementById('idSource').textContent =
    source === 'discord' ? '(hashed from your Discord ID)' : '(mock — no Discord ID found yet)';
  return myId;
}

async function init() {
  const stored = await chrome.storage.local.get(['salt', 'pepper', 'relayUrl']);
  document.getElementById('salt').value = stored.salt || '';
  document.getElementById('pepper').value = stored.pepper || '';
  document.getElementById('relayUrl').value = stored.relayUrl || 'http://localhost:3000';

  await refreshMyId();

  document.getElementById('copyId').addEventListener('click', () => {
    navigator.clipboard.writeText(myId);
  });

  document.getElementById('connect').addEventListener('click', async () => {
    const relayUrl = document.getElementById('relayUrl').value.trim();
    chrome.storage.local.set({ relayUrl });

    if (socket) socket.close();
    sessions.clear();

    setStatus('Connecting...');
    socket = connectToRelay(relayUrl);

    socket.on('connect', async () => {
      setStatus('Fetching config...');
      const config = await socket.emitWithAck('config', {});
      document.getElementById('salt').value = config.salt || '';
      document.getElementById('pepper').value = config.pepper || '';
      logLine(`[fetched config from relay: salt=${config.salt ? 'set' : 'empty'}, pepper=${config.pepper ? 'set' : 'empty'}]`);
      await refreshMyId();

      setStatus('Connected');
      socket.emit('register', { uid_hash: myId });
      logLine(`[connected, registered as ${myId}]`);
    });

    socket.on('disconnect', () => {
      setStatus('Disconnected');
      logLine('[disconnected]');
    });

    socket.on('error', () => {
      setStatus('Error');
      logLine('[connection error]');
    });

    socket.on('handshake', (payload) => {
      const session = getOrCreateSession(payload.sent_from, payload.channel);
      session.handleIncoming(payload);
    });
  });

  document.getElementById('startHandshake').addEventListener('click', () => {
    if (!socket) {
      logLine('[not connected]');
      return;
    }
    const peerId = document.getElementById('targetId').value.trim();
    const channel = document.getElementById('channel').value.trim();
    if (!peerId || !channel) return;

    const session = getOrCreateSession(peerId, channel);
    session.start();
  });

  document.getElementById('showStoredKeys').addEventListener('click', async () => {
    const records = await getAllKeys();
    if (records.length === 0) {
      logLine('[no stored keys]');
      return;
    }
    logLine(`[stored keys: ${records.length}]`);
    for (const r of records) {
      logLine(`  channel=${r.channel} user=${r.uidHash.slice(0, 8)} token=${r.token} createdAt=${new Date(r.createdAt).toISOString()}`);
    }
  });
}

init();
