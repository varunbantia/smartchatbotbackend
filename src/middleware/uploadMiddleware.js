// src/middleware/uploadMiddleware.js
import multer from "multer";

// Configure multer to store files temporarily in the 'uploads/' directory
export const upload = multer({ dest: "uploads/" });