// Entry point that actually runs on discord.com. Just extracts the id and
// reports it for now (console + chrome.storage.local) — no wiring into
// hashing/registration yet, that's a separate step once this is confirmed
// working against a real logged-in session.
(async () => {
  const id = await window.NOCC.getOwnDiscordId();

  if (id) {
    console.log('[nocc] discord id:', id);
    chrome.storage.local.set({ discordUserId: id });
  } else {
    console.warn('[nocc] could not find a Discord user id (user_id_cache missing/unexpected shape)');
  }
})();
