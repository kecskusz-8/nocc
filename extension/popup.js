import { connectToRelay } from './lib/relay-socket.js';
import { randomBytes, bytesToHex } from './crypto/random.js';
import { createHandshakeSession } from './crypto/three-pass.js';

function randomHexId() {
  return bytesToHex(randomBytes(32));
}

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
      onComplete: ({ ownKey, peerKey }) => {
        logLine(`[${peerId.slice(0, 8)}/${channel}] HANDSHAKE COMPLETE`);
        logLine(`  our key:  ${ownKey}`);
        logLine(`  their key: ${peerKey}`);
      },
    });
    sessions.set(key, session);
  }
  return session;
}

async function init() {
  const stored = await chrome.storage.local.get(['myId', 'relayUrl']);
  myId = stored.myId || randomHexId();
  if (!stored.myId) await chrome.storage.local.set({ myId });

  document.getElementById('myId').value = myId;
  document.getElementById('relayUrl').value = stored.relayUrl || 'http://localhost:3000';

  document.getElementById('copyId').addEventListener('click', () => {
    navigator.clipboard.writeText(myId);
  });

  document.getElementById('connect').addEventListener('click', () => {
    const relayUrl = document.getElementById('relayUrl').value.trim();
    chrome.storage.local.set({ relayUrl });

    if (socket) socket.close();
    sessions.clear();

    setStatus('Connecting...');
    socket = connectToRelay(relayUrl);

    socket.on('connect', () => {
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
}

init();
