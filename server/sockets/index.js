const { isValidHash, registerUser, userExists } = require('../services/users');

function attachSocketHandlers(io) {
  io.on('connection', (socket) => {
    socket.on('register', async ({ uid_hash } = {}) => {
      if (!isValidHash(uid_hash)) {
        console.log('[debug] register rejected, invalid hash:', uid_hash);
        return;
      }
      socket.join(uid_hash);
      await registerUser(uid_hash);
      console.log('[debug] registered + joined room:', uid_hash, 'socket', socket.id);
    });

    socket.on('handshake', (payload = {}) => {
      if (!isValidHash(payload.to)) {
        console.log('[debug] handshake rejected, invalid "to":', payload.to);
        return;
      }
      const room = io.sockets.adapter.rooms.get(payload.to);
      console.log('[debug] handshake to', payload.to, '-> room has', room ? room.size : 0, 'member(s)');
      io.to(payload.to).emit('handshake', payload);
    });

    socket.on('verify', async ({ uid_hash } = {}, callback) => {
      if (typeof callback !== 'function') return;

      if (!isValidHash(uid_hash)) {
        return callback({ error: 'uid_hash must be a 64-character hex string' });
      }

      callback({ exists: await userExists(uid_hash) });
    });
  });
}

module.exports = { attachSocketHandlers };
