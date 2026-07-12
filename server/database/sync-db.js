require('./db')
  .connect()
  .then(() => {
    console.log('table ready');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
