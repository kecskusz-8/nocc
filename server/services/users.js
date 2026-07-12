const { KnownUser } = require('../database/db');

const UID_HASH_RE = /^[a-f0-9]{64}$/i;

function isValidHash(hash) {
  return typeof hash === 'string' && UID_HASH_RE.test(hash);
}

async function registerUser(uidHash) {
  const [, created] = await KnownUser.findOrCreate({ where: { uidHash } });
  return created;
}

async function userExists(uidHash) {
  const user = await KnownUser.findByPk(uidHash);
  return Boolean(user);
}

module.exports = { isValidHash, registerUser, userExists };
