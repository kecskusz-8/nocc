const express = require('express');
const { isValidHash, registerUser, userExists } = require('../services/users');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { uid_hash } = req.body;

  if (!isValidHash(uid_hash)) {
    return res.status(400).json({ error: 'uid_hash must be a 64-character hex string' });
  }

  const created = await registerUser(uid_hash);
  res.status(created ? 201 : 200).json({ ok: true });
});

router.get('/verify/:uid_hash', async (req, res) => {
  const { uid_hash } = req.params;

  if (!isValidHash(uid_hash)) {
    return res.status(400).json({ error: 'uid_hash must be a 64-character hex string' });
  }

  const exists = await userExists(uid_hash);
  res.status(200).json({ exists });
});

module.exports = router;
