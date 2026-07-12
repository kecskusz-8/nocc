const { createApp } = require('./app');
const { connect } = require('./database/db');

if (!process.env.SALT) {
  throw new Error('SALT is required');
}

const PORT = process.env.PORT || 3000;
const app = createApp();

connect()
  .then(() => {
    app.listen(PORT, () => console.log(`nocc relay listening on ${PORT}`));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
