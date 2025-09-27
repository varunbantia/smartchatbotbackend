// src/controllers/sttController.js
import { speechClient } from "../config/gcpConfig.js";
import fs from "fs";
import { promisify } from "util";

const unlinkAsync = promisify(fs.unlink);

export async function handleSpeechToText(req, res, next) {
  const filePath = req.file?.path;
  if (!filePath) {
    return res.status(400).json({ error: "No audio file uploaded." });
  }

  try {
    const fileBytes = fs.readFileSync(filePath);
    const audio = { content: fileBytes.toString("base64") };

    const config = {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode: "en-US",
    };

    const request = { audio, config };

    const [response] = await speechClient.recognize(request);
    const transcription = response.results
      .map((result) => result.alternatives[0].transcript)
      .join("\n");

    res.json({ transcript: transcription });
  } catch (err) {
    next(err); // Pass error to the centralized handler
  } finally {
    await unlinkAsync(filePath); // Clean up the uploaded file
  }
}