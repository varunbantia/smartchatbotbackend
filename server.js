
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import speech from "@google-cloud/speech";
import admin from "firebase-admin";

dotenv.config();

// =================================================================
// 1. CONFIGURATION & INITIALIZATION
// =================================================================

const app = express();
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });

const AI_MODEL = "gpt-4.1";

// --- Initialize Firebase Admin with Service Account JSON ---
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });

  // ✅ Explicitly configure Firestore to use these credentials
  admin.firestore().settings({
    projectId: serviceAccount.project_id,
    credentials: {
      client_email: serviceAccount.client_email,
      private_key: serviceAccount.private_key,
    },
  });

  console.log("✅ Firebase Admin initialized successfully.");
} catch (err) {
  console.error("🔥 Firebase Admin initialization failed:", err);
  process.exit(1);
}

// --- Initialize Google Cloud STT client ---
let sttClient;
try {
  sttClient = new speech.SpeechClient();
  console.log("✅ Google Speech-to-Text client initialized.");
} catch (err) {
  console.error("🔥 Google Speech-to-Text client failed to initialize:", err);
  sttClient = null;
}

// =================================================================
// 2. MOCK DATABASE & HELPER FUNCTIONS
// =================================================================

const jobs = [
  { id: 1, title: "Senior Python Developer", skills: ["python", "django", "sql"], location: "benguluru", experience: "5 years" },
  { id: 2, title: "Frontend Developer (React)", skills: ["react", "javascript", "css"], location: "mohali", experience: "2 years" },
  { id: 3, title: "Data Scientist", skills: ["python", "machine learning", "tensorflow"], location: "remote", experience: "3 years" },
  { id: 4, title: "Junior Java Developer", skills: ["java", "spring"], location: "chandigarh", experience: "1 year" },
  { id: 5, title: "App Developer", skills: ["java", "kotlin", "android"], location: "benguluru", experience: "fresher" },
];

/**
 * Fetches a user's profile from Firestore using their UID.
 */
const fetchUserPreferences = async (uid) => {
  if (!uid) return null;
  try {
    const userDoc = await admin.firestore().collection("users").doc(uid).get();
    return userDoc.exists ? userDoc.data() : null;
  } catch (error) {
    console.error("Error fetching user from Firestore:", error);
    return null;
  }
};

/**
 * Filters the mock job list based on provided parameters.
 */
const findJobs = (params) => {
  const { skills, location } = params;
  let filteredJobs = jobs;

  if (skills) {
    const skillArray = skills.toLowerCase().split(",").map((s) => s.trim());
    filteredJobs = filteredJobs.filter((job) =>
      skillArray.some((skill) => job.skills.includes(skill))
    );
  }
  if (location) {
    filteredJobs = filteredJobs.filter(
      (job) => job.location.toLowerCase() === location.toLowerCase()
    );
  }

  return filteredJobs.length > 0 ? filteredJobs : "No jobs found matching those criteria.";
};


// =================================================================
// 3. AI TOOLS (FUNCTION CALLING) DEFINITION
// =================================================================
const tools = [
  {
    type: "function",
    function: {
      name: "find_jobs",
      description: "Searches for available jobs based on user-provided criteria like skills, location, or experience.",
      parameters: {
        type: "object",
        properties: {
          skills: { type: "string", description: "A comma-separated list of skills, e.g., 'python, react, sql'" },
          location: { type: "string", description: "The desired job location, e.g., 'Benguluru', 'Mohali', 'Remote'" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_info",
      description: "Retrieves the current user's complete profile information (name, skills, education, etc.) from the database.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// =================================================================
// 4. API ENDPOINTS
// =================================================================

/**
 * Speech-to-Text endpoint
 */
app.post("/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Audio file is missing." });
  if (!sttClient) return res.status(500).json({ error: "Google Speech client not initialized." });

  const languageCode = req.body.languageCode || "en-IN";

  try {
    const audioBytes = fs.readFileSync(req.file.path).toString("base64");

    const config = {
      encoding: "AMR",
      sampleRateHertz: 8000,
      languageCode: languageCode,
      alternativeLanguageCodes: ["en-IN", "hi-IN", "pa-IN"],
    };

    const [response] = await sttClient.recognize({ audio: { content: audioBytes }, config });
    const transcription = response.results?.map((r) => r.alternatives[0].transcript).join("\n") || "";

    fs.unlinkSync(req.file.path);
    res.json({ text: transcription });
  } catch (err) {
    console.error("STT Error:", err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: "Error transcribing audio" });
  }
});

/**
 * Chat endpoint
 */
app.post("/chat", async (req, res) => {
  const { message, history, uid, language } = req.body;
  if (!uid) return res.status(400).json({ error: "User ID (uid) is missing for personalization." });

  try {
    const userPrefs = await fetchUserPreferences(uid);
    let personalizationContext = "";
    if (userPrefs) {
      personalizationContext = `For personalization, here is the current user's profile:
- Name: ${userPrefs.name || "N/A"}
- Skills: ${userPrefs.skills || "N/A"}
- Highest Education: ${userPrefs.education || "N/A"}
- Experience: ${userPrefs.experience || "N/A"}
- Preferred Job Role: ${userPrefs.jobRole || "N/A"}
- Preferred Location: ${userPrefs.location || "N/A"}.`;
    }

    const languageInstruction = `Respond in ${language || "English"}.`;
    const systemPrompt = `You are RozgarAI, a helpful, empathetic, and highly conversational AI career advisor. Your primary goal is to sound like a friendly career guide.

### Your Core Instructions:
- **Personality:** Be warm, encouraging, and natural.
- **Query Handling Strategy:**
  - If a user asks you to **'find', 'search for', or 'list' specific jobs**, your first priority is to use the \`find_jobs\` tool to check the PGRKAM platform's database.
  - If the \`find_jobs\` tool returns "No jobs found", OR if the user asks a **general question** about a career (e.g., "What does a data scientist do?", "Tell me about being a graphic designer"), you MUST switch to using your own general knowledge. Provide a helpful overview of that career, including typical responsibilities, required skills, and salary outlook. **Do not just say 'I couldn't find any jobs'.**
- **Tool Usage:** When you do find jobs with the tool, present them conversationally and always mention the job's unique ID, like "(ID: 1)". For follow-up questions, use the \`get_job_details\` tool with that ID and provide the application link.
- **Personalization:** Actively use the user's profile information to tailor your responses.
- **Language:** ${languageInstruction}`;

    const transformedHistory = (Array.isArray(history) ? history : [])
      .filter((msg) => msg.message)
      .map((msg) => {
        const role = msg.type === 1 ? "assistant" : "user";
        return { role: role, content: msg.message };
      });

    const messages = [
      { role: "system", content: systemPrompt },
      ...transformedHistory,
      { role: "user", content: message || "..." },
    ];

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, messages, tools, tool_choice: "auto" }),
    });

    const data = await response.json();
    if (!data.choices || data.choices.length === 0) {
      console.error("❌ OpenAI Error Response:", JSON.stringify(data, null, 2));
      throw new Error("Invalid response from OpenAI.");
    }

    const firstResponseMsg = data.choices[0].message;

    if (firstResponseMsg.tool_calls) {
      const toolCall = firstResponseMsg.tool_calls[0];
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments || "{}");

      let toolResult;
      switch (functionName) {
        case "find_jobs":
          toolResult = findJobs(functionArgs);
          break;
        case "get_user_info":
          toolResult = await fetchUserPreferences(uid);
          break;
        default:
          toolResult = { error: "Function not implemented." };
      }

      const finalMessages = [
        ...messages,
        firstResponseMsg,
        {
          tool_call_id: toolCall.id,
          role: "tool",
          name: functionName,
          content: JSON.stringify(toolResult),
        },
      ];

      const finalResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: AI_MODEL, messages: finalMessages }),
      });

      const finalData = await finalResponse.json();
      if (!finalData.choices || finalData.choices.length === 0) {
                console.error("❌ OpenAI Error on SECOND call (after tool use):", JSON.stringify(finalData, null, 2));
                throw new Error("Invalid response from OpenAI on the second call.");
          }
      res.json({ reply: finalData.choices[0].message.content });
    } else {
      res.json({ reply: firstResponseMsg.content });
    }
  } catch (err) {
    console.error("Error in /chat endpoint:", err);
    res.status(500).json({ error: "An error occurred while processing your request." });
  }
  
});

// =================================================================
// 5. START SERVER
// =================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));