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

// ✅ Load service account from .env
const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

// ✅ Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ✅ Google Cloud Speech client
// ✅ new
const client = new speech.SpeechClient({
  projectId: serviceAccount.project_id,
  credentials: {
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key,
  },
});

const app = express();
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });

/* ===========================================================
   🔹 1. JOBS HELPER FUNCTION
=========================================================== */
async function getJobsFromDatabase({ location, keyword }) {
  console.log(`Querying Firestore for jobs. Location: ${location}, Keyword: ${keyword}`);
  try {
    let query = db.collection("jobs");

    if (location) {
      query = query.where("location", "==", location);
    }

    if (keyword) {
      const keywords = keyword.toLowerCase().split(/, |,/);
      query = query.where("requiredSkills", "array-contains-any", keywords);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      return JSON.stringify([]);
    }

    const jobs = [];
    snapshot.forEach(doc => {
      jobs.push({ id: doc.id, ...doc.data() });
    });

    return JSON.stringify(jobs);
  } catch (error) {
    console.error("Error fetching from Firestore:", error);
    return JSON.stringify({ error: "Failed to fetch jobs." });
  }
}

/* ===========================================================
   🔹 2. LLM TOOLS
=========================================================== */
const tools = [
  {
    type: "function",
    function: {
      name: "get_jobs",
      description: "Get a list of available jobs from Firestore based on location and skills/keywords.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City for job search" },
          keyword: { type: "string", description: "Keyword or comma-separated list of skills" },
        },
        required: [],
      },
    },
  }
];

/* ===========================================================
   🔹 3. CHAT ENDPOINT
=========================================================== */
app.post("/chat", async (req, res) => {
  const { history, userProfile } = req.body;

  let systemPrompt =
    "You are a helpful assistant for the Punjab Ghar Ghar Rozgar and Karobar Mission (PGRKAM) platform. Help with job searches, skill development, and counseling.";

  if (userProfile && userProfile.skills) {
    systemPrompt += ` The user has skills in: ${userProfile.skills}. Use them for personalized job recommendations.`;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...history
  ];

  try {
    // 🔹 First OpenAI call
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
        tool_choice: "auto",
      }),
    });

    const data = await initialResponse.json();
    const message = data.choices[0].message;

    if (message.tool_calls) {
      const toolCall = message.tool_calls[0];
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);

      // 🔹 Call our Firestore function
      const functionResult = await getJobsFromDatabase(functionArgs);

      const secondApiMessages = [
        ...messages,
        message,
        { tool_call_id: toolCall.id, role: "tool", name: functionName, content: functionResult }
      ];

      // 🔹 Second OpenAI call with results
      const finalResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          messages: secondApiMessages
        }),
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

/* ===========================================================
   🔹 4. SPEECH-TO-TEXT ENDPOINT
=========================================================== */
app.post("/stt", upload.single("audio"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const fileBytes = fs.readFileSync(filePath);

    const audio = { content: fileBytes.toString("base64") };

    const config = {
      encoding: "LINEAR16",   // ⚠️ match with Android recording format
      sampleRateHertz: 16000, // ⚠️ match recorder sample rate
      languageCode: "en-US",
    };

    const request = { audio, config };

    const [response] = await client.recognize(request);
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join("\n");

    fs.unlinkSync(filePath); // cleanup

    res.json({ transcript: transcription });
  } catch (error) {
    console.error("STT error:", error);
    res.status(500).json({ error: "Transcription failed" });
  }
});

/* ===========================================================
   🔹 5. START SERVER
=========================================================== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
