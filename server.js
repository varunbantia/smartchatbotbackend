import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import speech from "@google-cloud/speech";

dotenv.config();
const app = express();
app.use(bodyParser.json());

// Google Cloud STT client
const client = new speech.SpeechClient();

// Multer setup for audio upload
const upload = multer({ dest: "uploads/" });

/**
 * Chat endpoint (text message → bot reply)
 */
app.post("/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message content is missing." });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: message }],
      }),
    });

    const data = await response.json();

    if (data.choices && data.choices.length > 0) {
      res.json({ reply: data.choices[0].message.content });
    } else {
      res.status(500).json({ error: "Failed to get a valid response from OpenAI." });
    }
  } catch (err) {
    console.error("Error connecting to OpenAI API:", err);
    res.status(500).send("Error connecting to OpenAI API");
  }
});

/**
 * Speech-to-Text endpoint (audio → text + detected language)
 */
app.post("/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Audio file is missing." });
  }

  try {
    const file = fs.readFileSync(req.file.path);
    const audioBytes = file.toString("base64");

    const config = {
      // ✅ CORRECTED CONFIGURATION for .3gp files from Android's MediaRecorder
      encoding: "AMR",
      sampleRateHertz: 8000,
      languageCode: "en-IN", // Set your primary language
      alternativeLanguageCodes: ["hi-IN", "pa-IN"], // Hindi and Punjabi as alternatives
    };

    const audio = {
      content: audioBytes,
    };

    const request = {
      audio: audio,
      config: config,
    };

    const [response] = await client.recognize(request);

    // Cleanup the temporary file immediately after reading
    fs.unlinkSync(req.file.path); 

    if (!response.results || response.results.length === 0) {
      return res.json({ text: "", language: "unknown" });
    }

    const result = response.results[0];
    const transcription = result.alternatives[0].transcript;
    const detectedLanguage = result.languageCode || "en-IN";

    res.json({
      text: transcription,
      language: detectedLanguage,
    });
  } catch (err) {
    console.error("STT Error:", err);
    // Ensure file is deleted even if an error occurs
    if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
    }
    res.status(500).send("Error transcribing audio");
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));