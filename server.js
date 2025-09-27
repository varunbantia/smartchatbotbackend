import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";

// ✅ Firebase + Google Cloud
import admin from "firebase-admin";
import speech from "@google-cloud/speech";

dotenv.config();

// ✅ Load service account from environment variable
const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Initialize Google Speech Client
const client = new speech.SpeechClient({ credentials: serviceAccount });

const app = express();
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });

// -------------------------
// Firestore: get jobs function
// -------------------------
async function getJobsFromDatabase({ location, keyword }) {
  console.log(`Querying Firestore. Location: ${location}, Keyword: ${keyword}`);
  try {
    let query = db.collection("jobs");

    if (location) query = query.where("location", "==", location);
    if (keyword) {
      const keywords = keyword.toLowerCase().split(/, |,/);
      query = query.where("requiredSkills", "array-contains-any", keywords);
    }

    const snapshot = await query.get();
    if (snapshot.empty) return [];

    const jobs = [];
    snapshot.forEach(doc => jobs.push({ id: doc.id, ...doc.data() }));
    return jobs;
  } catch (err) {
    console.error("Error fetching jobs from Firestore:", err);
    return { error: "Failed to fetch jobs." };
  }
}

// -------------------------
// Tools for LLM
// -------------------------
const tools = [
  {
    type: "function",
    function: {
      name: "get_jobs",
      description: "Get a list of available jobs from PGRKAM based on location and skills/keywords.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City to search jobs in." },
          keyword: { type: "string", description: "Comma-separated skills." }
        },
        required: []
      }
    }
  }
];

// -------------------------
// Chat endpoint
// -------------------------
app.post("/chat", async (req, res) => {
  const { history, userProfile } = req.body;

  // Build system prompt
  let systemPrompt = `You are a helpful assistant for the Punjab Ghar Ghar Rozgar and Karobar Mission (PGRKAM) digital platform. Your purpose is to help users with job searches, skill development, and foreign counseling.`;
  if (userProfile && Array.isArray(userProfile.skills) && userProfile.skills.length > 0) {
    systemPrompt += ` The user has skills in: ${userProfile.skills.join(", ")}. Use these to provide personalized recommendations.`;
  }

  // Ensure history is always an array
  const messages = [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(history) ? history : [])
  ];

  try {
    // First OpenAI request
    const initialResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}` 
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages,
        tools,
        tool_choice: "auto"
      })
    });

    const data = await initialResponse.json();
    const message = data.choices[0].message;

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCall = message.tool_calls[0];
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);

      const functionResult = await getJobsFromDatabase(functionArgs);

      const secondApiMessages = [
        ...messages,
        message,
        { tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(functionResult) }
      ];

      const finalResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json", 
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}` 
        },
        body: JSON.stringify({ model: "gpt-3.5-turbo", messages: secondApiMessages })
      });

      const finalData = await finalResponse.json();
      res.json({ reply: finalData.choices[0].message.content });
    } else {
      res.json({ reply: message.content });
    }
  } catch (err) {
    console.error("Error in /chat endpoint:", err);
    res.status(500).send("Error connecting to OpenAI API");
  }
});

// -------------------------
// Speech-to-text endpoint
// -------------------------
app.post("/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).send("No audio file uploaded");

  try {
    const audioBytes = fs.readFileSync(req.file.path).toString("base64");

    const [response] = await client.recognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: "en-US"
      },
      audio: { content: audioBytes }
    });

    const transcription = response.results.map(r => r.alternatives[0].transcript).join("\n");
    res.json({ transcript: transcription });
  } catch (err) {
    console.error("Error in /stt endpoint:", err);
    res.status(500).send("STT processing failed");
  } finally {
    // Clean up uploaded file
    fs.unlink(req.file.path, () => {});
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
