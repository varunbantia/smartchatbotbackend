import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";

// ✅ Google Cloud Speech
import speech from "@google-cloud/speech";

dotenv.config();

const app = express();
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });

// Initialize Google Speech Client (optional, if using STT)
const client = new speech.SpeechClient({
  credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
});

// -------------------------
// Chat endpoint
// -------------------------
app.post("/chat", async (req, res) => {
  const { history } = req.body;

  // Default system prompt
  const systemPrompt = "You are a helpful and friendly AI chatbot. Assist the user in a conversational manner.";

  // Ensure history is always an array
  const messages = [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(history) ? history : []),
  ];

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages,
      }),
    });

    const data = await response.json();
    const message = data.choices[0].message.content;
    res.json({ reply: message });
  } catch (err) {
    console.error("Error in /chat endpoint:", err);
    res.status(500).send("Error connecting to OpenAI API");
  }
});

// -------------------------
// Speech-to-text endpoint (optional)
// -------------------------
app.post("/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).send("No audio file uploaded");

  try {
    const audioBytes = fs.readFileSync(req.file.path).toString("base64");

    const [response] = await client.recognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: "en-US",
      },
      audio: { content: audioBytes },
    });

    const transcript = response.results
      .map((r) => r.alternatives[0].transcript)
      .join("\n");

    res.json({ transcript });
  } catch (err) {
    console.error("Error in /stt endpoint:", err);
    res.status(500).send("STT processing failed");
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// -------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
