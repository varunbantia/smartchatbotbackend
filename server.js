import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import multer from "multer";
import fs from "fs";

// ✅ Firebase + Google Cloud
import admin from "firebase-admin";
import speech from "@google-cloud/speech";

// -------------------- CONFIG --------------------
const PORT = process.env.PORT || 5000;

// ✅ Parse service account from Render env
let serviceAccount = {};
try {
  serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "{}");

  // Fix private_key line breaks if needed
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
} catch (err) {
  console.error("❌ Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON:", err);
}

// ✅ Firebase Admin SDK
if (!admin.apps.length && serviceAccount.project_id) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// ✅ Google Cloud Speech client
const client = new speech.SpeechClient({
  projectId: serviceAccount.project_id,
  credentials: {
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key,
  },
});

// -------------------- APP INIT --------------------
const app = express();
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });

/* ===========================================================
   🔹 1. JOBS HELPER FUNCTION
=========================================================== */
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
    if (snapshot.empty) return JSON.stringify([]);

    const jobs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return JSON.stringify(jobs);
  } catch (error) {
    console.error("Firestore error:", error);
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
      description: "Get jobs from Firestore based on location and skills/keywords.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          keyword: { type: "string" },
        },
        required: [],
      },
    },
  },
];

/* ===========================================================
   🔹 3. CHAT ENDPOINT
=========================================================== */
app.post("/chat", async (req, res) => {
  const { history, userProfile } = req.body;

  let systemPrompt =
    "You are a helpful assistant for Punjab Ghar Ghar Rozgar and Karobar Mission (PGRKAM). Help with job searches, skills, and counseling.";

  if (userProfile?.skills) {
    systemPrompt += ` User skills: ${userProfile.skills}. Use for recommendations.`;
  }

  const messages = [{ role: "system", content: systemPrompt }, ...history];

  try {
    const initialResponse = await fetch("https://api.openai.com/v1/chat/completions", {
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

    const data = await initialResponse.json();
    const message = data.choices?.[0]?.message;

    if (message?.tool_calls) {
      const toolCall = message.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments);

      const functionResult = await getJobsFromDatabase(args);

      const secondApiMessages = [
        ...messages,
        message,
        {
          tool_call_id: toolCall.id,
          role: "tool",
          name: toolCall.function.name,
          content: functionResult,
        },
      ];

      const finalResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          messages: secondApiMessages,
        }),
      });

      const finalData = await finalResponse.json();
      return res.json({ reply: finalData.choices?.[0]?.message?.content || "No reply" });
    }

    res.json({ reply: message?.content || "No response" });
  } catch (err) {
    console.error("Chat error:", err);
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

    const request = {
      audio: { content: fileBytes.toString("base64") },
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: "en-US",
      },
    };

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
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
