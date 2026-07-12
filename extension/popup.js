function randomHexId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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

async function init() {
  const stored = await chrome.storage.local.get(['myId', 'relayUrl']);
  const myId = stored.myId || randomHexId();
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
      logLine(`from ${payload.sent_from}: ${JSON.stringify(payload.data)}`);
    });
  });

  document.getElementById('send').addEventListener('click', () => {
    if (!socket) {
      logLine('[not connected]');
      return;
    }
    const to = document.getElementById('targetId').value.trim();
    const data = document.getElementById('message').value;
    if (!to || !data) return;

    socket.emit('handshake', { to, data });
    logLine(`to ${to}: ${JSON.stringify(data)}`);
  });
}

init();
