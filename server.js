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

// -------------------------
// Multer setup for audio uploads
// -------------------------
const upload = multer({ dest: "uploads/" });

// -------------------------
// Initialize Google Cloud STT client
// -------------------------
let sttClient;
try {
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  sttClient = credentialsJson
    ? new speech.SpeechClient({ credentials: JSON.parse(credentialsJson) })
    : new speech.SpeechClient(); // fallback to default credentials
} catch (err) {
  console.error("Failed to initialize Google Speech client:", err);
  sttClient = null;
}

// -------------------------
// Optional: OpenAI tools for future function calls
// -------------------------
const tools = [
  {
    type: "function",
    function: {
      name: "get_time",
      description: "Returns the current server time",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// -------------------------
// Chat endpoint
// -------------------------
app.post("/chat", async (req, res) => {
  const { message, history } = req.body;

  if (!message && (!history || history.length === 0)) {
    return res.status(400).json({ error: "Message content is missing." });
  }

  const systemPrompt =
    "You are a helpful and friendly AI chatbot. Assist the user conversationally. You may call functions if needed.";

  const messages = [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(history) ? history : []),
    { role: "user", content: message },
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
        tools,
        tool_choice: "auto",
      }),
    });

    const data = await response.json();
    const messageObj = data.choices?.[0]?.message;

    if (!messageObj) {
      return res.status(500).json({ error: "Failed to get a valid response from OpenAI." });
    }

    // Handle OpenAI function calls (extendable)
    if (messageObj.tool_calls && messageObj.tool_calls.length > 0) {
      const toolCall = messageObj.tool_calls[0];
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments || "{}");

      let functionResult;
      if (functionName === "get_time") {
        functionResult = { time: new Date().toISOString() };
      } else {
        functionResult = { error: "Function not implemented yet." };
      }

      const secondApiMessages = [
        ...messages,
        messageObj,
        {
          tool_call_id: toolCall.id,
          role: "tool",
          name: functionName,
          content: JSON.stringify(functionResult),
        },
      ];

      const finalResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model: "gpt-3.5-turbo", messages: secondApiMessages }),
      });

      const finalData = await finalResponse.json();
      res.json({ reply: finalData.choices[0].message.content });
    } else {
      res.json({ reply: messageObj.content });
    }
  } catch (err) {
    console.error("Error in /chat endpoint:", err);
    res.status(500).json({ error: "Error connecting to OpenAI API" });
  }
});

// -------------------------
// Speech-to-Text endpoint
// -------------------------
app.post("/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Audio file is missing." });
  if (!sttClient) return res.status(500).json({ error: "Google Speech client not initialized." });

  try {
    const audioBytes = fs.readFileSync(req.file.path).toString("base64");

    const config = {
      encoding: "AMR",
      sampleRateHertz: 8000,
      languageCode: "en-IN",
      alternativeLanguageCodes: ["hi-IN", "pa-IN"],
    };

    const audio = { content: audioBytes };
    const request = { audio, config };

    const [response] = await sttClient.recognize(request);

    const transcription =
      response.results?.map((r) => r.alternatives[0].transcript).join("\n") || "";

    // Cleanup uploaded file
    fs.unlinkSync(req.file.path);

    res.json({ text: transcription, language: "en-IN" });
  } catch (err) {
    console.error("STT Error:", err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: "Error transcribing audio" });
  }
});

// -------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
