import { getAllKeys } from './storage/key-store.js';
import { getMyId } from './identity.js';

// Returns subfolders of extension/hooks/ using the extension package filesystem.
// Only available in extension pages (not service workers).
function listHookFolders() {
  return new Promise((resolve) => {
    chrome.runtime.getPackageDirectoryEntry((root) => {
      if (chrome.runtime.lastError) { resolve([]); return; }
      root.getDirectory('hooks', {}, (dir) => {
        const reader = dir.createReader();
        const names = [];
        function readBatch() {
          reader.readEntries((entries) => {
            if (!entries.length) { resolve(names); return; }
            for (const e of entries) if (e.isDirectory) names.push(e.name);
            readBatch();
          }, () => resolve(names));
        }
        readBatch();
      }, () => resolve([]));
    });
  });
}

async function discoverAndSyncHooks() {
  const discovered = await listHookFolders();
  const { hookFolders: cached } = await chrome.storage.local.get('hookFolders');

  const changed = JSON.stringify(discovered.sort()) !== JSON.stringify((cached ?? []).slice().sort());
  if (changed) {
    await chrome.runtime.sendMessage({ type: 'nocc-register-hooks', hookFolders: discovered });
  }

  const { loadedHooks } = await chrome.storage.local.get('loadedHooks');
  renderHookList(loadedHooks ?? []);
}

function renderHookList(hooks) {
  const el = document.getElementById('hookList');
  if (!hooks.length) {
    el.innerHTML = '<span style="font:11px monospace;color:var(--muted)">none</span>';
    return;
  }
  el.innerHTML = hooks.map((h) =>
    `<div class="hook-row"><div class="hook-dot"></div><span>${h.name}</span></div>`
  ).join('');
}

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
    source === 'platform' ? '(hashed from your platform ID)' : '(mock — no platform ID found yet)';
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
  await discoverAndSyncHooks();

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
