// Reads the current user's own Discord ID out of the web client's own
// localStorage cache — no bot/OAuth API, no token, per ARCHITECTURE.md's
// "no Discord API usage" stance. This is reverse-engineered and undocumented
// by Discord, so it's written defensively: never throws, retries briefly
// since the cache is populated asynchronously during Discord's own login
// bootstrap, and validates the result actually looks like a snowflake ID.
//
// Newer Discord builds block direct `window.localStorage` access on the top
// level page to deter casual scraping; a same-origin <iframe> gets its own
// window with an unpatched localStorage that still reads the same underlying
// storage, which is the standard community workaround.

const CACHE_KEY = 'user_id_cache';
const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 400;

function readRaw() {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  document.body.appendChild(iframe);
  try {
    return iframe.contentWindow.localStorage.getItem(CACHE_KEY);
  } finally {
    iframe.remove();
  }
}

function extractId(raw) {
  if (!raw) return null;

  // Deliberately not JSON.parse-ing the value into a JS number: Discord
  // snowflakes exceed Number.MAX_SAFE_INTEGER (2^53), so if the cache ever
  // stores a bare unquoted number (valid JSON, e.g. `123456789012345678`
  // instead of a quoted string), JSON.parse would silently round it to the
  // nearest representable double and hand back a corrupted ID. Matching the
  // digit run directly out of the raw text sidesteps that entirely, and
  // works the same whether the value is a bare string, a quoted string, or
  // an array of either — we just want the first snowflake-shaped substring.
  const match = raw.match(/\d{17,20}/);
  return match ? match[0] : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getOwnDiscordId() {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const id = extractId(readRaw());
    if (id) return id;
    if (attempt < RETRY_ATTEMPTS) await delay(RETRY_DELAY_MS);
  }
  return null;
}

// Classic (non-module) content script: exposed via a namespaced global
// instead of `export`, since static content_scripts module support is
// Chrome-version-dependent and content.js (loaded right after this, same
// isolated world) just needs to call this one function.
window.NOCC = window.NOCC || {};
window.NOCC.getOwnDiscordId = getOwnDiscordId;
