// Turns the raw Discord ID (extracted by get-user-id.js/content.js and
// stashed in chrome.storage.local) into the registered identity used
// everywhere else: the hashed uid_hash from crypto/uid-hash.js.
//
// Falls back to a persisted random mock id when no Discord ID is present
// yet (e.g. the user hasn't opened discord.com in a tab with the extension
// loaded) — keeps the existing two-mock-client dev workflow working without
// requiring two real Discord accounts + matching SALT just to test the
// relay/handshake/storage pieces.

import { randomBytes, bytesToHex } from '../crypto/random.js';
import { computeUidHash } from '../crypto/uid-hash.js';

export async function getMyId() {
  const stored = await chrome.storage.local.get(['discordUserId', 'salt', 'pepper', 'mockId']);

  if (stored.discordUserId) {
    const id = await computeUidHash(stored.discordUserId, stored.salt || '', stored.pepper || '');
    return { id, source: 'discord' };
  }

  let mockId = stored.mockId;
  if (!mockId) {
    mockId = bytesToHex(randomBytes(32));
    await chrome.storage.local.set({ mockId });
  }
  return { id: mockId, source: 'mock' };
}
