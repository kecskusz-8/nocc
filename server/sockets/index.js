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
