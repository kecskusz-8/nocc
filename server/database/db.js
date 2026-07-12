const { Sequelize, DataTypes } = require('sequelize');

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const sequelize = new Sequelize(DATABASE_URL, { logging: false });

const KnownUser = sequelize.define('KnownUser', {
  uidHash: {
    type: DataTypes.STRING(64),
    primaryKey: true,
  },
}, {
  tableName: 'known_users',
  underscored: true,
  timestamps: false,
});

async function connect() {
  await sequelize.authenticate();
  await sequelize.sync();
}

module.exports = { sequelize, KnownUser, connect };
