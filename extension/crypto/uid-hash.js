// uid_hash = SHA256(uid + SALT + PEPPER), per ARCHITECTURE.md's "UID
// hashing" section. Real Discord UIDs never touch the relay or database;
// only this hash does.

import { sha256, bytesToHex } from './random.js';

export async function computeUidHash(discordId, salt = '') {
  const bytes = new TextEncoder().encode(`${discordId}${salt}`);
  return bytesToHex(await sha256(bytes));
}
