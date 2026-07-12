const express = require('express');
const { KnownUser } = require('../database/db');

const UID_HASH_RE = /^[a-f0-9]{64}$/i;

const router = express.Router();

router.post('/register', async (req, res) => {
  const { uid_hash } = req.body;

  if (typeof uid_hash !== 'string' || !UID_HASH_RE.test(uid_hash)) {
    return res.status(400).json({ error: 'uid_hash must be a 64-character hex string' });
  }

  const [, created] = await KnownUser.findOrCreate({ where: { uidHash: uid_hash } });
  res.status(created ? 201 : 200).json({ ok: true });
});

router.get('/verify/:uid_hash', async (req, res) => {
  const { uid_hash } = req.params;

  if (!UID_HASH_RE.test(uid_hash)) {
    return res.status(400).json({ error: 'uid_hash must be a 64-character hex string' });
  }

  const user = await KnownUser.findByPk(uid_hash);
  res.status(200).json({ exists: Boolean(user) });
});

module.exports = router;
