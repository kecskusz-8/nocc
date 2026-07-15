// uid_hash = SHA256(uid + SALT + PEPPER), per ARCHITECTURE.md's "UID
// hashing" section. Real platform UIDs never touch the relay or database;
// only this hash does.

import { sha256, bytesToHex } from './random.js';

export async function computeUidHash(platformId, salt = '', pepper = '') {
  const bytes = new TextEncoder().encode(`${platformId}${salt}${pepper}`);
  return bytesToHex(await sha256(bytes));
}
