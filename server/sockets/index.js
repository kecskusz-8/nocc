const { isValidHash, registerUser, userExists } = require('../services/users');

// Returns false (and bumps the counter) when the socket has exceeded `max`
// calls within a rolling `windowMs` millisecond window.
function checkRateLimit(socket, key, max, windowMs) {
  const countKey = `${key}Count`;
  const windowKey = `${key}Window`;
  const now = Date.now();
  if (!socket.data[countKey] || now - socket.data[windowKey] > windowMs) {
    socket.data[countKey] = 0;
    socket.data[windowKey] = now;
  }
  return ++socket.data[countKey] <= max;
}

function attachSocketHandlers(io) {
  io.on('connection', (socket) => {
    socket.on('register', async ({ uid_hash } = {}) => {
      if (socket.data.uidHash) return;
      if (!checkRateLimit(socket, 'register', 5, 60_000)) return;
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
      if (!checkRateLimit(socket, 'handshake', 100, 60_000)) return;
      if (!isValidHash(payload.to)) return;

      io.to(payload.to).emit('handshake', { ...payload, sent_from: sentFrom });
    });

    // Hands SALT to any connecting client — needed to compute uid_hash before
    // registering. PEPPER is intentionally omitted (server-side secret only).
    socket.on('config', (_payload, callback) => {
      if (typeof callback !== 'function') return;
      callback({ salt: process.env.SALT });
    });

    socket.on('verify', async ({ uid_hash } = {}, callback) => {
      if (typeof callback !== 'function') return;

      if (!socket.data.uidHash) return callback({ error: 'not registered' });
      if (!checkRateLimit(socket, 'verify', 20, 60_000)) return callback({ error: 'rate limited' });

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
