const crypto = require('crypto');
const { KnownUser } = require('../database/db');

const UID_HASH_RE = /^[a-f0-9]{64}$/i;

function isValidHash(hash) {
  return typeof hash === 'string' && UID_HASH_RE.test(hash);
}

// Derives the key stored in the DB so that a compromised database cannot be
// used to enumerate users without knowing the server's PEPPER secret.
function pepperHash(uidHash) {
  const pepper = process.env.PEPPER;
  if (!pepper) return uidHash;
  return crypto.createHmac('sha256', pepper).update(uidHash).digest('hex');
}

async function registerUser(uidHash) {
  const dbHash = pepperHash(uidHash);
  const [, created] = await KnownUser.findOrCreate({ where: { uidHash: dbHash } });
  return created;
}

async function userExists(uidHash) {
  const dbHash = pepperHash(uidHash);
  const user = await KnownUser.findByPk(dbHash);
  return Boolean(user);
}

module.exports = { isValidHash, registerUser, userExists };
