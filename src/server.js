// src/server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import apiRoutes from "./routes/apiRoutes.js";

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// --- Middleware ---
app.use(bodyParser.json());

// --- Routes ---
app.use("/api", apiRoutes); // All routes are prefixed with /api

// --- Centralized Error Handler ---
app.use((err, req, res, next) => {
  console.error("🔥 Global Error Handler:", err.stack);
  res.status(500).json({
    error: "An internal server error occurred. Please try again later.",
  });
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});