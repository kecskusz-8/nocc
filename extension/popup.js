import { getAllKeys } from './storage/key-store.js';
import { getMyId } from './discord/identity.js';

function logLine(text) {
  const log = document.getElementById('log');
  const line = document.createElement('div');
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

let myId = null;

async function refreshMyId() {
  const { id, source } = await getMyId();
  myId = id;
  document.getElementById('myId').value = myId;
  document.getElementById('idSource').textContent =
    source === 'discord' ? '(hashed from your Discord ID)' : '(mock — no Discord ID found yet)';
}

async function refreshStatus() {
  const resp = await chrome.runtime.sendMessage({ type: 'nocc-status' }).catch(() => null);
  const connected = resp?.connected ?? false;
  document.getElementById('statusDot').className = 'status-dot' + (connected ? ' connected' : '');
  document.getElementById('statusText').textContent = connected ? 'Connected to relay' : 'Disconnected';
}

async function init() {
  const stored = await chrome.storage.local.get(['relayUrl']);
  document.getElementById('relayUrl').value = stored.relayUrl || 'http://localhost:3000';

  await refreshMyId();
  await refreshStatus();

  // Refresh status every 2 s while popup is open.
  const statusInterval = setInterval(refreshStatus, 2000);
  window.addEventListener('unload', () => clearInterval(statusInterval));

  document.getElementById('copyId').addEventListener('click', () => {
    navigator.clipboard.writeText(myId);
  });

  document.getElementById('relayUrl').addEventListener('change', () => {
    const relayUrl = document.getElementById('relayUrl').value.trim();
    chrome.storage.local.set({ relayUrl });
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
