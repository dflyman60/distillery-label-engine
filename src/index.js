require("dotenv").config()

const express = require("express")
const cors = require("cors")
const { Pool } = require("pg")

const labelsRoutes = require("./routes/labels")
const ttbEventsRouter = require("./routes/ttbEvents")
const ttbStatusSummaryRouter = require("./routes/ttbStatusSummary")

const app = express()
const PORT = process.env.PORT || 4000

// ✅ DB (Pool) - only if your other routers need it
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
})

// middleware
app.use(cors())
app.use(express.json())

// Health Check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", message: "Distillery Label Engine is alive" })
})

console.log("BOOT: index.js loaded, mounting routes now")

// ✅ Mount labels ONLY here (do NOT mount the same router twice)
app.use("/api/labels", labelsRoutes)

// Other routes
app.use("/api", ttbEventsRouter)
app.use(ttbStatusSummaryRouter(db))

// Static frontend
app.use(express.static("public"))

app.listen(PORT, () => {
  console.log(`Distillery Label Engine running at http://localhost:${PORT}`)
})

