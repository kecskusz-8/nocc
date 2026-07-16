// NOCC hook skeleton — copy this folder, rename it, fill in the TODOs.
//
// This file runs as a content script inside the target platform's tab.
// It never handles raw key bytes — all crypto goes through the background
// service worker via chrome.runtime.sendMessage.
//
// NOCC ciphertext format: 'NOCC:<senderUidHash>:<hex>'
//   senderUidHash — 64 hex chars (SHA-256 uid hash, embedded so receivers know which key to use)
//   hex           — AES-256-GCM bytes as hex (12-byte IV prepended)

const NOCC_PREFIX = "NOCC:";

// --- 1. Identity -------------------------------------------------------
function extractPlatformUserId() {
  // Extract the platform's own user ID for the current logged-in account and
  // store it so background.js can derive the uid_hash used on the relay.

  return null; // TODO
}

(function initIdentity() {
  const uid = extractPlatformUserId();
  if (uid) chrome.storage.local.set({ platformUserId: uid });
})();

// --- 2. Keep the service worker alive ----------------------------------
// An open port prevents the SW from going dormant during a handshake.
// The port also receives 'nocc-handshake-complete' so we can re-scan
// messages that arrived before the key exchange finished.

const port = chrome.runtime.connect({ name: "nocc-platform" });
port.onMessage.addListener((msg) => {
  if (msg.type === "nocc-handshake-complete") scanMessages();
});

chrome.runtime.sendMessage({ type: "nocc-wake" });

// --- 3. Send intercept -------------------------------------------------
// Listen for the platform's message-submit event, encrypt the plaintext,
// and substitute the ciphertext before the platform's own handler fires.
// TODO: replace the event target and selector with real platform values.

function interceptSend() {
  // TODO: find the real send button / keyboard shortcut / form submit.
  document.addEventListener("submit", async (e) => {
    // TODO: confirm this is the chat form, not some unrelated form.
    if (!input) return;

    const plaintext = input.value.trim();
    if (!plaintext || plaintext.startsWith(NOCC_PREFIX)) return;

    // TODO: extract the channel ID and peer UID hash from the page.
    const channel = getCurrentChannelId(); // TODO
    const peerId = getCurrentPeerUidHash(); // TODO

    // Trigger a handshake if we don't have the peer's key yet.
    await chrome.runtime.sendMessage({
      type: "nocc-start-handshake",
      channel,
      peerId,
    });

    const { ciphertext, error } = await chrome.runtime.sendMessage({
      type: "nocc-encrypt",
      plaintext,
      channel,
    });

    if (error) return; // no active key yet — send plaintext as-is, or implement a warning to the user.

    e.preventDefault();
    input.value = ciphertext;
    // TODO: re-trigger the platform's own send logic with the mutated input.
  });
}

// --- 4. Receive scan ---------------------------------------------------
// Walk visible message nodes looking for NOCC-prefixed strings and replace
// them inline with the decrypted plaintext (or a pending indicator).

async function scanMessages() {
  // TODO: selector for the platform's message nodes, and add a data-nocc-message attribute to them.
  const nodes = document.querySelectorAll("[data-nocc-message]");

  for (const node of nodes) {
    const text = node.textContent.trim();
    if (!text.startsWith(NOCC_PREFIX)) continue;
    if (node.dataset.noccDecrypted) continue; // already processed

    // TODO: extract the sender's uid_hash and channel from the DOM.
    const peerId = node.dataset.noccSender; 
    const channel = node.dataset.noccChannel; 

    // peerId is parsed from the ciphertext by background.js and returned in the response.
    const { plaintext, peerId: resolvedPeerId } = await chrome.runtime.sendMessage({
      type: "nocc-decrypt",
      ciphertext: text,
      channel,
    });

    node.dataset.noccDecrypted = "1";
    node.textContent = plaintext ?? "[NOCC: key pending]";
  }
}

// --- 5. Observe DOM for new messages -----------------------------------
// Re-scan whenever new nodes are inserted (platform uses a virtual DOM that
// mounts/unmounts message batches as you scroll).

const observer = new MutationObserver(() => scanMessages());
observer.observe(document.body, { childList: true, subtree: true });

// --- 6. Wire everything up ---------------------------------------------

interceptSend();
scanMessages();

// --- 7. TODO: platform-specific tweaks ------------------------------------
// Add any other platform-specific tweaks, or whatever you need to make the extension work nicely with the platform.
// For example, you might want to add a "NOCC" button to the platform's UI that toggles encryption on/off for the current channel, or a warning if the peer doesn't have NOCC installed.

// --- Helpers (TODOs) ---------------------------------------------------

function getCurrentChannelId() {
  // TODO: extract from URL, DOM, or platform state.
  return null;
}

function getCurrentPeerUidHash() {
  // TODO: read the other user's platform ID from the DOM, hash it the same
  // way background.js does (SHA256(uid + salt)), and return the hex string.
  // You can ask background.js for your own hash via:
  //   chrome.storage.local.get(['myUidHash'])
  return null;
}
