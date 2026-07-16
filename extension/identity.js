// Resolves the local user's identity as used throughout NOCC: a uid_hash
// derived from the platform-native user ID (set in chrome.storage.local as
// `platformUserId` by whichever platform content script is running), or a
// random mock ID when no platform ID has been captured yet.

import { randomBytes, bytesToHex } from './crypto/random.js';
import { computeUidHash } from './crypto/uid-hash.js';

export async function getMyId() {
  const stored = await chrome.storage.local.get(['platformUserId', 'platformHookName', 'salt', 'mockId']);

  if (stored.platformUserId) {
    const id = await computeUidHash(stored.platformUserId, stored.salt || '', '', stored.platformHookName || '');
    return { id, source: 'platform' };
  }

  let mockId = stored.mockId;
  if (!mockId) {
    mockId = bytesToHex(randomBytes(32));
    await chrome.storage.local.set({ mockId });
  }
  return { id: mockId, source: 'mock' };
}
