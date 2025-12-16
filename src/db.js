// src/db.js (CommonJS)
require("dotenv").config()

const { Pool } = require("pg")

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set")
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
})

// quick sanity log (remove later if you want)
console.log("✅ pg pool initialized:", typeof pool.connect === "function")

module.exports = pool

