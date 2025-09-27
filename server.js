import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";

// ✅ Google Cloud Speech (optional)
import speech from "@google-cloud/speech";

dotenv.config();

const app = express();
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });

// Initialize Google Speech Client
const client = new speech.SpeechClient({
  credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
});

// -------------------------
// Example Tools / Function Calls
// -------------------------
// You can add more tools here later
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
// Chat endpoint with function support
// -------------------------
app.post("/chat", async (req, res) => {
  const { history } = req.body;

  const systemPrompt =
    "You are a helpful and friendly AI chatbot. Assist the user in a conversational manner. You can also call functions if needed.";

  const messages = [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(history) ? history : []),
  ];

  try {
    // Initial OpenAI request
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages,
        tools,          // Pass the tools here
        tool_choice: "auto",
      }),
    });

    const data = await response.json();
    const message = data.choices[0].message;

    // Check if the model wants to call a function
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCall = message.tool_calls[0];
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments || "{}");

      // Handle tool calls (add more actions here)
      let functionResult;
      if (functionName === "get_time") {
        functionResult = { time: new Date().toISOString() };
      } else {
        functionResult = { error: "Function not implemented yet." };
      }

      // Add tool call result to conversation
      const secondApiMessages = [
        ...messages,
        message,
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
      // Normal chat response
      res.json({ reply: message.content });
    }
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
