// uid_hash = SHA256(hookName + NUL + uid + SALT + PEPPER), per
// ARCHITECTURE.md's "UID hashing" section. The hookName prefix isolates
// hashes across hooks so the same raw platform UID on two different
// platforms never maps to the same relay identity. Real platform UIDs
// never touch the relay or database; only this hash does.

import { sha256, bytesToHex } from './random.js';

export async function computeUidHash(platformId, salt = '', pepper = '', hookName = '') {
  const bytes = new TextEncoder().encode(`${hookName}\0${platformId}${salt}${pepper}`);
  return bytesToHex(await sha256(bytes));
}
