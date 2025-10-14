// server.js
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import speech from "@google-cloud/speech";
import admin from "firebase-admin";
import { URL } from "url";
import { franc } from "franc";
import langs from "langs";

dotenv.config();

// =================================================================
// 1. CONFIGURATION & INITIALIZATION
// =================================================================

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
const upload = multer({ dest: "uploads/" });

// AI model to use with OpenAI chat completions (you can change if needed)
const AI_MODEL = process.env.OPENAI_MODEL || "gpt-3.5-turbo";

let sttClient = null;

// Parse Firebase & Google credentials from ENV (must be JSON strings)
const firebaseServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : null;

const googleServiceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
  : null;

try {
  if (!firebaseServiceAccount) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
  admin.initializeApp({
    credential: admin.credential.cert(firebaseServiceAccount),
    projectId: firebaseServiceAccount.project_id,
  });
  console.log("✅ Firebase Admin initialized successfully.");
} catch (err) {
  console.error("🔥 Firebase initialization failed:", err);
  process.exit(1);
}

try {
  if (!googleServiceAccount) throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS_JSON");
  sttClient = new speech.SpeechClient({
    credentials: {
      client_email: googleServiceAccount.client_email,
      private_key: googleServiceAccount.private_key,
    },
    projectId: googleServiceAccount.project_id,
  });
  console.log("✅ Google Speech-to-Text client initialized successfully.");
} catch (err) {
  console.error("🔥 Google STT initialization failed:", err);
  // We won't exit — STT endpoints will return an error if invoked
}

const db = admin.firestore();

// =================================================================
// 2. HELPERS: Language detection & utilities
// =================================================================

/**
 * detectLanguageSimple(message)
 * Returns one of: "English", "Hindi", "Punjabi"
 * Approach:
 *  - If message contains Devanagari Unicode -> Hindi
 *  - If message contains Gurmukhi Unicode -> Punjabi
 *  - Otherwise use franc -> map to the three supported languages if possible
 */
function detectLanguageSimple(message) {
  if (!message || typeof message !== "string" || message.trim() === "") return "English";

  // Detect Hindi (Devanagari)
  if (/[\u0900-\u097F]/.test(message)) return "Hindi";

  // Detect Punjabi (Gurmukhi)
  if (/[\u0A00-\u0A7F]/.test(message)) return "Punjabi";

  // Use franc fallback
  try {
    const code3 = franc(message);
    if (code3 && code3 !== "und") {
      const info = langs.where("3", code3);
      if (info && info.name) {
        if (info.name.toLowerCase().includes("english")) return "English";
        if (info.name.toLowerCase().includes("hindi")) return "Hindi";
        if (info.name.toLowerCase().includes("punjabi")) return "Punjabi";
      }
    }
  } catch (e) {
    // ignore
  }

  // default
  return "English";
}

async function fetchUserPreferences(uid) {
  if (!uid) return null;
  try {
    const snap = await db.collection("users").doc(uid).get();
    return snap.exists ? snap.data() : null;
  } catch (err) {
    console.error("Error fetching user prefs:", err);
    return null;
  }
}

const findJobs = async (params) => {
  try {
    const { query, employment_types } = params || {};
    if (!query || query.trim() === "") return [];

    const url = new URL("https://jsearch.p.rapidapi.com/search");
    url.searchParams.append("query", query);
    if (employment_types) url.searchParams.append("employment_types", (employment_types || "").toUpperCase());
    url.searchParams.append("num_pages", "1");

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": process.env.JSEARCH_API_KEY,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      },
    });

    const result = await response.json();
    if (!result?.data || result.data.length === 0) return [];

    const jobs = result.data.slice(0, 7).map((job) => ({
      job_id: job.job_id,
      title: job.job_title,
      company: job.employer_name,
      location: `${job.job_city || ""}${job.job_city && job.job_state ? ", " : ""}${job.job_state || ""}`.trim(),
      description: job.job_description || "No description available.",
      applicationLink: job.job_apply_link || `https://www.google.com/search?q=${encodeURIComponent(job.job_title + " " + job.employer_name)}`,
    }));

    return jobs;
  } catch (err) {
    console.error("Error in findJobs:", err);
    return [];
  }
};

// =================================================================
// 3. Tools configuration (function definitions for the model)
// =================================================================

const tools = [
  {
    type: "function",
    function: {
      name: "find_jobs",
      description: "Searches for real, live job listings from an external database based on a search query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Full search query (e.g., 'android developer in Bengaluru')" },
          employment_types: { type: "string", description: "Hiring type: FULLTIME, CONTRACTOR, INTERN, etc." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_user_info",
      description: "Retrieves the user's profile stored in Firestore.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  }
];

// =================================================================
// 4. API Endpoints
// =================================================================

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "SmartChatbot backend running" });
});

/**
 * STT endpoint:
 * Receives an audio file (field name: audio) and optional languageCode.
 * Returns { text: "...", detectedLanguage: "English" }
 */
app.post("/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Audio file missing." });
  if (!sttClient) return res.status(500).json({ error: "STT client not initialized." });

  // If client provides languageCode, use it, else default to "en-IN" to start
  const providedLang = (req.body.languageCode || "").trim();
  const languageCode = providedLang || "en-IN";

  try {
    const audioBytes = fs.readFileSync(req.file.path).toString("base64");
    const config = {
      encoding: "AMR",
      sampleRateHertz: 8000,
      languageCode,
      alternativeLanguageCodes: ["en-IN", "hi-IN", "pa-IN"]
    };

    const audio = { content: audioBytes };
    const request = { audio, config };

    const [response] = await sttClient.recognize(request);
    const transcription = response.results?.map(r => r.alternatives[0].transcript).join("\n") || "";

    // Detect language from transcription (prefer script detection)
    const detectedLanguage = detectLanguageSimple(transcription || "");

    return res.json({ text: transcription, detectedLanguage });
  } catch (err) {
    console.error("STT Error:", err);
    return res.status(500).json({ error: "Error transcribing audio." });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

/**
 * Chat endpoint:
 * Body: { message, history, uid }
 *
 * Returns: { reply, detectedLanguage }
 */
app.post("/chat", async (req, res) => {
  try {
    const { message, history, uid } = req.body;

    if (!uid) return res.status(400).json({ error: "User ID is missing." });
    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ error: "Message is empty." });
    }

    // 1) Detect language (English/Hindi/Punjabi)
    const detectedLanguage = detectLanguageSimple(message);
    console.log("Detected language:", detectedLanguage);

    // 2) Fetch user prefs for personalization (if available)
    const userPrefs = await fetchUserPreferences(uid);
    const personalizationContext = userPrefs ? `User name: ${userPrefs.name || "N/A"}. Skills: ${userPrefs.skills || "N/A"}. Location: ${userPrefs.location || "N/A"}.` : "";

    // 3) Compose system prompt with explicit language instruction
    const systemPrompt = `You are RozgarAI, an expert and empathetic AI career mentor.
Follow these rules:
1) Tone: helpful, professional, concise.
2) When responding, use EXACTLY the user's detected language and ONLY that language.
   Detected language for this request: ${detectedLanguage}.
   Supported languages: English, Hindi, Punjabi.
3) If the user's intent is a job search, use the 'find_jobs' tool. Do not hallucinate job details.
4) For non-job queries give short, actionable guidance.
5) Never mix languages within a single response. Reply only in ${detectedLanguage}.`;

    // 4) Build messages for OpenAI function-calling style
    // Transform history (expected format from app: array of { message, type } where type maybe constants)
    const transformedHistory = (Array.isArray(history) ? history : [])
      .filter(m => m && (m.message || m.text))
      .map(m => {
        // preserve compatibility: some clients use { message, type } others { text, isUser }
        const content = m.message || m.text || "";
        const isAssistant = m.type === 1 || m.role === "assistant" || m.isUser === false;
        return { role: isAssistant ? "assistant" : "user", content };
      });

    const messages = [
      { role: "system", content: systemPrompt },
      ...transformedHistory,
      { role: "user", content: message }
    ];

    // 5) Ask OpenAI (chat completions). We pass tools for potential function calls.
    // NOTE: This implementation uses the older "chat/completions" endpoint.
    const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        functions: tools.map(t => t.function ? t.function : t),
        function_call: "auto"
      })
    });

    const openAiData = await openAiResponse.json();

    if (!openAiData || !openAiData.choices || openAiData.choices.length === 0) {
      console.error("OpenAI returned no choices:", JSON.stringify(openAiData, null, 2));
      return res.status(500).json({ error: "Invalid response from language model." });
    }

    const firstMsg = openAiData.choices[0].message;

    // If the model wants to call a function (tool)
    if (firstMsg && firstMsg.function_call) {
      const functionName = firstMsg.function_call.name;
      const functionArgsRaw = firstMsg.function_call.arguments || "{}";
      let functionArgs;
      try {
        functionArgs = JSON.parse(functionArgsRaw);
      } catch (e) {
        functionArgs = {};
      }

      console.log("Model requested tool:", functionName, functionArgs);

      let toolResult = null;
      if (functionName === "find_jobs") {
        toolResult = await findJobs(functionArgs);
      } else if (functionName === "get_user_info") {
        toolResult = await fetchUserPreferences(uid);
      } else {
        toolResult = { error: "Unknown function requested." };
      }

      // Append the tool result and call the model again to get final message
      const messagesWithTool = [
        ...messages,
        firstMsg, // the assistant's tool_call message
        {
          role: "tool",
          name: functionName,
          content: JSON.stringify(toolResult)
        }
      ];

      const finalResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: messagesWithTool
        })
      });

      const finalData = await finalResponse.json();
      if (!finalData || !finalData.choices || finalData.choices.length === 0) {
        console.error("OpenAI second call failed:", JSON.stringify(finalData, null, 2));
        return res.status(500).json({ error: "Failed to generate final response." });
      }

      const finalMsg = finalData.choices[0].message?.content || finalData.choices[0].message || "";
      // Return reply and detectedLanguage so client knows what language was used
      return res.json({ reply: finalMsg, detectedLanguage });
    } else {
      // No tool call — direct reply
      const replyContent = firstMsg?.content || "";
      return res.json({ reply: replyContent, detectedLanguage });
    }
  } catch (err) {
    console.error("Error in /chat:", err);
    return res.status(500).json({ error: "An error occurred processing the chat." });
  }
});

/**
 * Skill gap analysis
 * GET /skills/analyze?uid=...
 */
app.get("/skills/analyze", async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: "User ID required." });

  try {
    const userPrefs = await fetchUserPreferences(uid);
    if (!userPrefs || !userPrefs.jobRole) return res.status(404).json({ error: "User profile or jobRole missing." });

    const userSkills = (userPrefs.skills || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
    const jobRole = userPrefs.jobRole;

    // Ask LLM for required skills (simple approach)
    const skillsQuestion = `List the top 8 most important technical skills for a '${jobRole}'. Respond ONLY with a comma-separated list.`;
    const skillsResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, messages: [{ role: "user", content: skillsQuestion }] })
    });
    const skillsData = await skillsResp.json();
    const requiredSkillsText = skillsData?.choices?.[0]?.message?.content || "";
    const requiredSkills = requiredSkillsText.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const missingSkills = requiredSkills.filter(s => !userSkills.includes(s));

    const learningResources = {};
    for (const skill of missingSkills) {
      const resourceQuestion = `Provide a reputable, public URL for learning '${skill}'. Reply only with the URL.`;
      try {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model: AI_MODEL, messages: [{ role: "user", content: resourceQuestion }] })
        });
        const d = await r.json();
        const url = (d?.choices?.[0]?.message?.content || "").trim();
        if (url.startsWith("http")) learningResources[skill] = url;
      } catch (err) {
        // continue if resource lookup fails
      }
    }

    return res.json({ jobRole, requiredSkills, missingSkills, learningResources });
  } catch (err) {
    console.error("Error in /skills/analyze:", err);
    return res.status(500).json({ error: "Skill analysis failed." });
  }
});

// Jobs endpoints (search saved/list)
app.get("/jobs", async (req, res) => {
  const { uid, q, employment_types } = req.query;
  try {
    let query = q;
    if (!query && uid) {
      const prefs = await fetchUserPreferences(uid);
      query = prefs ? `${prefs.skills || "jobs"} in ${prefs.location || "India"}` : "tech jobs in India";
    } else if (!query) {
      query = "jobs in India";
    }

    const jobsResult = await findJobs({ query, employment_types });
    return res.json(jobsResult);
  } catch (err) {
    console.error("Error in /jobs:", err);
    return res.status(500).json({ error: "Error fetching jobs." });
  }
});

app.get("/users/:uid/saved-jobs", async (req, res) => {
  const { uid } = req.params;
  try {
    const snap = await db.collection("users").doc(uid).collection("saved_jobs").get();
    const saved = snap.docs.map(d => d.data());
    return res.json(saved);
  } catch (err) {
    console.error("Error fetching saved jobs:", err);
    return res.status(500).json({ error: "Could not fetch saved jobs." });
  }
});

app.post("/users/:uid/saved-jobs", async (req, res) => {
  const { uid } = req.params;
  const jobData = req.body;
  const jobId = jobData?.job_id;
  if (!jobId) return res.status(400).json({ error: "Job ID missing." });
  try {
    await db.collection("users").doc(uid).collection("saved_jobs").doc(jobId).set(jobData);
    return res.status(201).json({ message: "Job saved." });
  } catch (err) {
    console.error("Error saving job:", err);
    return res.status(500).json({ error: "Could not save job." });
  }
});

app.delete("/users/:uid/saved-jobs/:jobId", async (req, res) => {
  const { uid, jobId } = req.params;
  try {
    await db.collection("users").doc(uid).collection("saved_jobs").doc(jobId).delete();
    return res.json({ message: "Job unsaved." });
  } catch (err) {
    console.error("Error deleting saved job:", err);
    return res.status(500).json({ error: "Could not unsave job." });
  }
});

// =================================================================
// 5. START SERVER
// =================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
