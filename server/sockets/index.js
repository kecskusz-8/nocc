const { isValidHash, registerUser, userExists } = require('../services/users');

function attachSocketHandlers(io) {
  io.on('connection', (socket) => {
    socket.on('register', async ({ uid_hash } = {}) => {
      if (!isValidHash(uid_hash)) return;

      try {
        socket.join(uid_hash);
        await registerUser(uid_hash);
        socket.data.uidHash = uid_hash;
      } catch (err) {
        socket.leave(uid_hash);
        console.error('register failed:', err);
      }
    });

    socket.on('handshake', (payload = {}) => {
      const sentFrom = socket.data.uidHash;
      if (!sentFrom) return;
      if (!isValidHash(payload.to)) return;

      io.to(payload.to).emit('handshake', { ...payload, sent_from: sentFrom });
    });

    // Hands SALT/PEPPER to any connecting client, no registration required
    // (a client needs these to compute its own uid_hash before it can even
    // register). Deliberate deviation from treating SALT/PEPPER as strictly
    // out-of-band secrets, per the operator's own choice for this relay.
    socket.on('config', (_payload, callback) => {
      if (typeof callback !== 'function') return;
      callback({ salt: process.env.SALT, pepper: process.env.PEPPER || null });
    });

    socket.on('verify', async ({ uid_hash } = {}, callback) => {
      if (typeof callback !== 'function') return;

      if (!isValidHash(uid_hash)) {
        return callback({ error: 'uid_hash must be a 64-character hex string' });
      }

      try {
        callback({ exists: await userExists(uid_hash) });
      } catch (err) {
        console.error('verify failed:', err);
        callback({ error: 'internal error' });
      }
    });
  });
}

module.exports = { attachSocketHandlers };
