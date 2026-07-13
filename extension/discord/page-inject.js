// Runs in the MAIN world at document_start (declared in manifest.json) so it
// wraps window.fetch and XMLHttpRequest BEFORE Discord's bundle captures them.
// Communicates with the isolated-world content.js via postMessage to do the
// actual encryption (IndexedDB / chrome.storage are only available there).
(function () {
  const pending = new Map(); // id → resolve
  let nextId = 0;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'nocc-encrypt-response') return;
    const resolve = pending.get(event.data.id);
    if (!resolve) return;
    pending.delete(event.data.id);
    resolve(event.data.encrypted);
  });

  function requestEncryption(content, channelId) {
    return new Promise((resolve) => {
      const id = ++nextId;

      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve(content); // content script didn't respond in time — send plaintext
        }
      }, 2000);

      pending.set(id, (encrypted) => {
        clearTimeout(timer);
        resolve(encrypted);
      });

      window.postMessage({ type: 'nocc-encrypt-request', id, content, channelId }, '*');
    });
  }

  function isMessagePost(method, url) {
    return (
      method === 'POST' &&
      typeof url === 'string' &&
      /\/api\/v\d+\/channels\/(\d+)\/messages$/.test(url)
    );
  }

  function channelIdFrom(url) {
    const m = String(url).match(/\/channels\/(\d+)\/messages$/);
    return m ? m[1] : null;
  }

  function isEncryptEnabled() {
    return document.getElementById('nocc-state')?.dataset?.encrypt !== '0';
  }

  // --- fetch ---
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    if (init && isMessagePost(init.method, url) && init.body && isEncryptEnabled()) {
      try {
        const body = JSON.parse(init.body);
        if (typeof body.content === 'string' && body.content.length > 0) {
          const encrypted = await requestEncryption(body.content, channelIdFrom(url));
          init = { ...init, body: JSON.stringify({ ...body, content: encrypted }) };
        }
      } catch (_) {}
    }
    return originalFetch(input, init);
  };

  // --- XMLHttpRequest ---
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._noccMethod = method ? method.toUpperCase() : '';
    this._noccUrl = String(url);
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    if (isMessagePost(xhr._noccMethod, xhr._noccUrl) && body && isEncryptEnabled()) {
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed.content === 'string' && parsed.content.length > 0) {
          const channelId = channelIdFrom(xhr._noccUrl);
          requestEncryption(parsed.content, channelId).then((encrypted) => {
            originalSend.call(xhr, JSON.stringify({ ...parsed, content: encrypted }));
          });
          return; // hold the original send until encryption is done
        }
      } catch (_) {}
    }
    return originalSend.apply(this, arguments);
  };
})();
