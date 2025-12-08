// src/db.js
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL is not set. Postgres will not be available.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // If you get SSL errors, set PGSSLMODE=disable in Railway
  ssl:
    process.env.PGSSLMODE === "disable"
      ? false
      : {
          rejectUnauthorized: false,
        },
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};

