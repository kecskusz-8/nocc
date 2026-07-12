const http = require('node:http');
const { Server } = require('socket.io');
const { createApp } = require('./app');
const { connect } = require('./database/db');
const { attachSocketHandlers } = require('./sockets');

if (!process.env.SALT) {
  throw new Error('SALT is required');
}

const PORT = process.env.PORT || 3000;
const app = createApp();
const server = http.createServer(app);
const io = new Server(server);

attachSocketHandlers(io);

connect()
  .then(() => {
    server.listen(PORT, () => console.log(`nocc relay listening on ${PORT}`));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
