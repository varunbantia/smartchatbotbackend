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

// ---------------------------
// 1) App + config
// ---------------------------
const app = express();
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });
const AI_MODEL = "gpt-3.5-turbo";

let sttClient;

// load credentials from env (strings containing JSON)
const firebaseServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
const googleServiceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "{}");

try {
  admin.initializeApp({
    credential: admin.credential.cert(firebaseServiceAccount),
    projectId: firebaseServiceAccount.project_id,
  });
  sttClient = new speech.SpeechClient({
    credentials: {
      client_email: googleServiceAccount.client_email,
      private_key: googleServiceAccount.private_key,
    },
    projectId: googleServiceAccount.project_id,
  });
  console.log("✅ Firebase + Google STT initialized");
} catch (err) {
  console.error("Initialization error:", err);
  process.exit(1);
}

const db = admin.firestore();

// ---------------------------
// 2) Helpers: language detection + user prefs + job search
// ---------------------------

/**
 * Very small detector focused on Hindi, Punjabi (Gurmukhi), English.
 * Returns object { name: 'Hindi'|'Punjabi'|'English', code: 'hi-IN'|'pa-IN'|'en-IN' }
 */
function detectLanguageFromText(text) {
  if (!text || text.trim().length === 0) return { name: "English", code: "en-IN" };

  // check Devanagari = Hindi (approx)
  if (/[\u0900-\u097F]/.test(text)) return { name: "Hindi", code: "hi-IN" };

  // check Gurmukhi = Punjabi (approx)
  if (/[\u0A00-\u0A7F]/.test(text)) return { name: "Punjabi", code: "pa-IN" };

  // fallback: use franc -> langs
  const langCode3 = franc(text, { minLength: 1 }); // may return 'eng', 'hin', 'pan', etc.
  if (langCode3 && langCode3 !== "und") {
    const info = langs.where("3", langCode3);
    if (info) {
      const name = info.name.toLowerCase();
      if (name.includes("hindi")) return { name: "Hindi", code: "hi-IN" };
      if (name.includes("punjabi")) return { name: "Punjabi", code: "pa-IN" };
      if (name.includes("english")) return { name: "English", code: "en-IN" };
    }
  }

  // default
  return { name: "English", code: "en-IN" };
}

const fetchUserPreferences = async (uid) => {
  if (!uid) return null;
  try {
    const doc = await db.collection("users").doc(uid).get();
    return doc.exists ? doc.data() : null;
  } catch (err) {
    console.error("fetchUserPreferences error:", err);
    return null;
  }
};

const findJobs = async ({ query, employment_types }) => {
  try {
    const url = new URL("https://jsearch.p.rapidapi.com/search");
    url.searchParams.append("query", query);
    if (employment_types) url.searchParams.append("employment_types", employment_types.toUpperCase());
    url.searchParams.append("num_pages", "1");

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": process.env.JSEARCH_API_KEY,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      },
    });
    const data = await resp.json();
    if (!data.data || data.data.length === 0) return [];
    return data.data.slice(0, 5).map((job) => ({
      job_id: job.job_id,
      title: job.job_title,
      company: job.employer_name,
      location: `${job.job_city || ""}${job.job_city && job.job_state ? ", " : ""}${job.job_state || ""}`.trim(),
      description: job.job_description || "No description available.",
      applicationLink: job.job_apply_link || `https://www.google.com/search?q=${encodeURIComponent(job.job_title + " at " + job.employer_name)}`,
    }));
  } catch (err) {
    console.error("findJobs error:", err);
    return [];
  }
};

// ---------------------------
// 3) Function tool definitions (same structure you used)
// ---------------------------
const tools = [
  {
    type: "function",
    function: {
      name: "find_jobs",
      description: "Searches for real job listings using skills and location.",
      parameters: {
        type: "object",
        properties: {
          skills: { type: "string", description: "Job title or skills" },
          location: { type: "string", description: "Location to search" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_info",
      description: "Fetches user profile from Firestore.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// ---------------------------
// 4) STT endpoint: upload audio, transcribe, detect language
// ---------------------------
app.post("/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Audio file missing." });
  if (!sttClient) return res.status(500).json({ error: "STT client not initialized." });

  try {
    // read file bytes
    const audioBytes = fs.readFileSync(req.file.path).toString("base64");

    // Let Google STT attempt with alternatives: set languageCode to en-IN but include alternatives
    const config = {
      encoding: "AMR",
      sampleRateHertz: 8000,
      languageCode: "en-IN",
      alternativeLanguageCodes: ["hi-IN", "pa-IN"],
      model: "default",
      enableAutomaticPunctuation: true,
    };

    const audio = { content: audioBytes };
    const request = { audio, config };
    const [response] = await sttClient.recognize(request);

    const transcription = (response.results || []).map(r => r.alternatives?.[0]?.transcript || "").join("\n") || "";

    const detected = detectLanguageFromText(transcription); // {name, code}

    res.json({ text: transcription, language: detected.name, languageCode: detected.code });
  } catch (err) {
    console.error("STT error:", err);
    res.status(500).json({ error: "Error transcribing audio" });
  } finally {
    // cleanup file
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

// ---------------------------
// 5) Chat endpoint: respond in same language
// ---------------------------
app.post("/chat", async (req, res) => {
  const { message, history, uid, language } = req.body;
  if (!uid) return res.status(400).json({ error: "User ID required." });

  try {
    // If a language provided by client, trust it; else detect from text
    let detected = { name: "English", code: "en-IN" };
    if (language) {
      const lower = String(language).toLowerCase();
      if (lower.includes("hindi")) detected = { name: "Hindi", code: "hi-IN" };
      else if (lower.includes("punjabi") || lower.includes("panjabi") || lower.includes("pa")) detected = { name: "Punjabi", code: "pa-IN" };
      else detected = { name: "English", code: "en-IN" };
    } else {
      detected = detectLanguageFromText(message || "");
    }

    // personalization
    const userPrefs = await fetchUserPreferences(uid);
    const personalization = userPrefs ? `User name: ${userPrefs.name || "N/A"}. Skills: ${userPrefs.skills || "N/A"}.` : "";

    // Build system prompt that forces language output
    // We will explicitly request "Reply entirely in <language>" to reduce mixing.
    const languageLabel = detected.name; // Hindi/Punjabi/English
    const systemPrompt = `
You are RozgarAI, a helpful AI career advisor.
The user is communicating in ${languageLabel}.
You MUST reply entirely in ${languageLabel} only (do not include English translations).
If user asks for jobs, call the 'find_jobs' tool. Do not invent job data; use exact data from the tool.
${personalization}
`;

    // build messages (history mapping similar to your code)
    const transformedHistory = (Array.isArray(history) ? history : [])
      .filter(m => m.message)
      .map(m => ({ role: m.type === 1 ? "assistant" : "user", content: m.message }));

    const messages = [
      { role: "system", content: systemPrompt },
      ...transformedHistory,
      { role: "user", content: message || "" }
    ];

    // call OpenAI first time
    const callBody = {
      model: AI_MODEL,
      messages,
      tools,
      tool_choice: "auto"
    };

    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(callBody),
    });

    const openaiData = await openaiResp.json();
    if (!openaiData.choices || openaiData.choices.length === 0) {
      console.error("OpenAI empty response:", JSON.stringify(openaiData, null, 2));
      throw new Error("OpenAI returned no choices");
    }

    const firstMsg = openaiData.choices[0].message;

    // if model calls a tool, execute and pass result back in second call
    if (firstMsg.tool_calls) {
      const toolCall = firstMsg.tool_calls[0];
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments || "{}");
      let toolResult;

      if (functionName === "find_jobs") {
        const { skills, location } = functionArgs;
        const searchQuery = `${skills || "jobs"}${location ? ` in ${location}` : ""}`;
        toolResult = await findJobs({ query: searchQuery });
      } else if (functionName === "get_user_info") {
        toolResult = await fetchUserPreferences(uid);
      } else {
        toolResult = { error: "Unknown function" };
      }

      const finalMessages = [
        ...messages,
        firstMsg,
        {
          role: "tool",
          name: functionName,
          content: JSON.stringify(toolResult),
          tool_call_id: toolCall.id
        }
      ];

      const secondCallBody = { model: AI_MODEL, messages: finalMessages };
      const finalResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(secondCallBody),
      });

      const finalData = await finalResp.json();
      if (!finalData.choices || finalData.choices.length === 0) {
        console.error("OpenAI second call empty:", JSON.stringify(finalData, null, 2));
        throw new Error("OpenAI second call returned no choices");
      }

      const finalReply = finalData.choices[0].message.content;
      // Return reply AND language to client
      res.json({ reply: finalReply, language: detected.name, languageCode: detected.code });
      return;
    }

    // No tool calls, reply directly
    const reply = firstMsg.content;
    res.json({ reply, language: detected.name, languageCode: detected.code });

  } catch (err) {
    console.error("/chat error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------------------------
// 6) Other endpoints preserved (skills, jobs, saved jobs)
// ---------------------------

app.get("/skills/analyze", async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: "User ID required." });

  try {
    const userPrefs = await fetchUserPreferences(uid);
    if (!userPrefs || !userPrefs.jobRole) return res.status(404).json({ error: "User profile or job role not found." });

    const userSkills = (userPrefs.skills || "").toLowerCase().split(",").map(s => s.trim());
    const jobRole = userPrefs.jobRole;

    const skillsQuestion = `List the top 8 most important technical skills for a '${jobRole}'. Respond ONLY with a comma-separated list.`;
    const skillsResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, messages: [{ role: "user", content: skillsQuestion }] }),
    });
    const skillsData = await skillsResp.json();
    const requiredSkillsText = skillsData.choices[0].message.content;
    const requiredSkills = requiredSkillsText.toLowerCase().split(",").map(s => s.trim());
    const missingSkills = requiredSkills.filter(skill => !userSkills.includes(skill));

    const learningResources = {};
    for (const skill of missingSkills) {
      const resourceQuestion = `Provide one high-quality public URL for a tutorial or course to learn '${skill}'. Respond ONLY with the URL.`;
      const resourceResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: AI_MODEL, messages: [{ role: "user", content: resourceQuestion }] }),
      });
      const resourceData = await resourceResp.json();
      const url = resourceData.choices[0].message.content.trim();
      if (url.startsWith("http")) learningResources[skill] = url;
    }

    res.json({ jobRole, requiredSkills, missingSkills, learningResources });
  } catch (err) {
    console.error("/skills/analyze error:", err);
    res.status(500).json({ error: "Skill analysis failed." });
  }
});

app.get("/jobs", async (req, res) => {
  const { uid, q, employment_types } = req.query;
  try {
    let searchQuery = q;
    if (!searchQuery && uid) {
      const userPrefs = await fetchUserPreferences(uid);
      searchQuery = userPrefs ? `${userPrefs.skills || "jobs"} in ${userPrefs.location || "India"}` : "tech jobs in India";
    } else if (!searchQuery) searchQuery = "jobs in India";
    const jobs = await findJobs({ query: searchQuery, employment_types });
    res.json(jobs);
  } catch (err) {
    console.error("/jobs error:", err);
    res.status(500).json({ error: "Error fetching jobs." });
  }
});

app.get("/users/:uid/saved-jobs", async (req, res) => {
  const { uid } = req.params;
  try {
    const snap = await db.collection("users").doc(uid).collection("saved_jobs").get();
    res.json(snap.docs.map(d => d.data()));
  } catch (err) {
    console.error("saved jobs get error:", err);
    res.status(500).json({ error: "Could not fetch saved jobs." });
  }
});

app.post("/users/:uid/saved-jobs", async (req, res) => {
  const { uid } = req.params;
  const jobData = req.body;
  const jobId = jobData.job_id;
  if (!jobId) return res.status(400).json({ error: "Job ID missing." });
  try {
    await db.collection("users").doc(uid).collection("saved_jobs").doc(jobId).set(jobData);
    res.status(201).json({ message: "Job saved" });
  } catch (err) {
    console.error("save job error:", err);
    res.status(500).json({ error: "Could not save job." });
  }
});

app.delete("/users/:uid/saved-jobs/:jobId", async (req, res) => {
  const { uid, jobId } = req.params;
  try {
    await db.collection("users").doc(uid).collection("saved_jobs").doc(jobId).delete();
    res.json({ message: "Job unsaved" });
  } catch (err) {
    console.error("unsave job error:", err);
    res.status(500).json({ error: "Could not unsave job." });
  }
});

// ---------------------------
// 7) Start server
// ---------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
