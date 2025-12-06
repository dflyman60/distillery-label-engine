// src/index.js
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const labelRoutes = require("./routes/labels");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// API routes
app.use("/api/labels", labelRoutes);

// Static frontend
app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`Distillery Label Engine running at http://localhost:${PORT}`);
});

