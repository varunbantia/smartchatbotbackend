// src/routes/apiRoutes.js
import express from "express";
import { handleChatRequest } from "../controllers/chatController.js";
import { handleSpeechToText } from "../controllers/sttController.js";
import { upload } from "../middleware/uploadMiddleware.js";

const router = express.Router();

router.post("/chat", handleChatRequest);
router.post("/stt", upload.single("audio"), handleSpeechToText);

export default router;