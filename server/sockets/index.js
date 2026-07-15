const crypto = require('crypto');
const { isValidHash, registerUser, userExists } = require('../services/users');

// ip → Set of active socket IDs
const connectionsByIp = new Map();
// ip → { count, windowStart } for per-IP registration rate limiting
const registersByIp = new Map();

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
    const ip = socket.handshake.address.replace(/^::ffff:/, '');

    // IP connection cap: max 10 concurrent sockets per IP
    if (!connectionsByIp.has(ip)) connectionsByIp.set(ip, new Set());
    const ipConns = connectionsByIp.get(ip);
    if (ipConns.size >= 10) { socket.disconnect(true); return; }
    ipConns.add(socket.id);

    // Send PoW challenge — client must solve before register is accepted
    const nonce = crypto.randomBytes(16).toString('hex');
    socket.data.challenge = nonce;
    socket.data.powSolved = false;
    socket.emit('pow_challenge', { nonce, difficulty: 20 });

    socket.on('disconnect', () => {
      ipConns.delete(socket.id);
      if (ipConns.size === 0) connectionsByIp.delete(ip);
    });

    socket.on('pow', ({ solution } = {}, callback) => {
      if (typeof callback !== 'function') return;
      if (socket.data.powSolved) return callback({ ok: true });

      const hash = crypto
        .createHash('sha256')
        .update(`${socket.data.challenge}:${solution}`)
        .digest();

      // 20 leading zero bits: bytes 0–1 = 0x00, top nibble of byte 2 = 0x0
      if (hash[0] === 0 && hash[1] === 0 && (hash[2] & 0xf0) === 0) {
        socket.data.powSolved = true;
        callback({ ok: true });
      } else {
        callback({ ok: false });
      }
    });

    socket.on('register', async ({ uid_hash } = {}) => {
      if (socket.data.uidHash) return;
      if (!socket.data.powSolved) return;

      // IP register rate limit: 2 per 10 minutes
      const now = Date.now();
      const reg = registersByIp.get(ip) ?? { count: 0, windowStart: now };
      if (now - reg.windowStart > 600_000) { reg.count = 0; reg.windowStart = now; }
      if (reg.count >= 2) return;
      reg.count++;
      registersByIp.set(ip, reg);

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
