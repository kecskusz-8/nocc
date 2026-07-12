const { Server } = require('socket.io');
const { connect } = require('./database/db');
const { attachSocketHandlers } = require('./sockets');

if (!process.env.SALT) {
  throw new Error('SALT is required');
}

const PORT = process.env.PORT || 3000;
const io = new Server(PORT, { cors: { origin: '*' } });

attachSocketHandlers(io);

connect()
  .then(() => console.log(`nocc relay listening on ${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
