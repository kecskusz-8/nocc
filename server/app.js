const express = require('express');
const usersRouter = require('./routes/users');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(usersRouter);
  return app;
}

module.exports = { createApp };
