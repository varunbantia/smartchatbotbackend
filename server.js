// server.js (full rewritten backend with stronger system prompt & enhanced chat flow)
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
// CONFIG
// =================================================================
const app = express();
app.use(bodyParser.json({ limit: "1mb" }));
const upload = multer({ dest: "uploads/" });

// Set a strong model by default; override via .env if desired
const AI_MODEL = process.env.AI_MODEL || "gpt-4-turbo";

// Global STT client handle
let sttClient;

// FIREBASE & GOOGLE STT credentials (from ENV, parse JSON strings)
const firebaseServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
const googleServiceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "{}");

try {
  // Initialize Firebase Admin
  admin.initializeApp({
    credential: admin.credential.cert(firebaseServiceAccount),
    projectId: firebaseServiceAccount.project_id,
  });
  console.log("✅ Firebase Admin initialized successfully.");

  // Initialize Google Cloud Speech-to-Text
  sttClient = new speech.SpeechClient({
    credentials: {
      client_email: googleServiceAccount.client_email,
      private_key: googleServiceAccount.private_key,
    },
    projectId: googleServiceAccount.project_id,
  });
  console.log("✅ Google Speech-to-Text client initialized successfully.");
} catch (err) {
  console.error("🔥 Initialization failed:", err);
  process.exit(1);
}

const db = admin.firestore();

// =================================================================
// HELPERS
// =================================================================

const fetchUserPreferences = async (uid) => {
  if (!uid) return null;
  try {
    const doc = await db.collection("users").doc(uid).get();
    return doc.exists ? doc.data() : null;
  } catch (err) {
    console.error("Error fetching user preferences:", err);
    return null;
  }
};

const findJobs = async ({ query, employment_types } = {}) => {
  try {
    if (!process.env.JSEARCH_API_KEY) {
      console.warn("JSEARCH_API_KEY not set — returning empty job list.");
      return [];
    }

    const url = new URL("https://jsearch.p.rapidapi.com/search");
    url.searchParams.append("query", query || "jobs");
    if (employment_types) url.searchParams.append("employment_types", employment_types.toUpperCase());
    url.searchParams.append("num_pages", "1");

    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": process.env.JSEARCH_API_KEY,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      },
    });

    const data = await resp.json();
    if (!data || !data.data) return [];

    const jobs = data.data.slice(0, 5).map((job) => ({
      job_id: job.job_id,
      title: job.job_title,
      company: job.employer_name,
      location: `${job.job_city || ""}${job.job_city && job.job_state ? "," : ""}${job.job_state || ""}`.trim(),
      description: job.job_description || "No description available.",
      applicationLink:
        job.job_apply_link ||
        `https://www.google.com/search?q=${encodeURIComponent(job.job_title + " at " + job.employer_name)}`,
    }));

    return jobs;
  } catch (err) {
    console.error("Error in findJobs:", err);
    return [];
  }
};

// Utility: format assistant reply (small cosmetic formatting)
const formatReply = (text) => {
  if (!text) return "";
  let replyText = text.trim();

  // Make bolded headings stand out for many clients (simple replacement)
  replyText = replyText.replace(/\*\*(.*?)\*\*/g, (m, p1) => `\n\n>>> ${p1.toUpperCase()}\n`);

  // Collapse multiple blank lines
  replyText = replyText.replace(/\n{3,}/g, "\n\n");

  return replyText.trim();
};

// Build the powerful system prompt (returns string)
const buildSystemPrompt = ({ detectedLanguage, personalizationContext }) => {
  return `
You are RozgarAI — an expert multilingual career mentor, technical advisor, and growth companion.
You MUST follow these rules strictly.

====================
CORE OBJECTIVES
====================
1) Help users get jobs, learn skills, prepare for interviews, and grow their careers.
2) Use tools when job/user data is required (find_jobs, get_user_info).
3) Always be honest: if you don't know something, say so and suggest a way to find out.
4) Prioritize actionable advice (step-by-step instructions, resources, examples).
5) Be empathetic and motivational when appropriate.

====================
LANGUAGE & TONE
====================
- Always respond fully in ${detectedLanguage}.
- Keep tone professional but friendly, clear, and encouraging.
- Structure answers with sections, e.g. "Overview", "Why this matters", "Next steps", "Resources".

====================
SAFETY, ACCURACY & TOOLS
====================
- Never invent or fabricate job listings — show only exact data returned by the 'find_jobs' tool.
- When you need to fetch jobs or user data, call the appropriate tool.
- If the user asks for non-career factual advice (medical/legal/financial), provide a high-level answer and advise to consult a qualified professional.
- If you produce code, include small runnable examples and mention runtime assumptions.

${personalizationContext || ""}
`;
};

// =================================================================
// FUNCTIONS (for model to call)
// These describe the function schema we send to the OpenAI API.
// =================================================================
const functionsForOpenAI = [
  {
    name: "find_jobs",
    description: "Search for live job listings based on skills, title or location.",
    parameters: {
      type: "object",
      properties: {
        skills: { type: "string", description: "Job title or skills (e.g., 'React developer')" },
        location: { type: "string", description: "Location (e.g., 'Bengaluru')" },
        employment_types: { type: "string", description: "Employment type e.g., full_time, part_time" },
      },
      required: [],
    },
  },
  {
    name: "get_user_info",
    description: "Retrieve profile information for the given user from Firestore.",
    parameters: {
      type: "object",
      properties: {
        uid: { type: "string", description: "User ID to fetch data for" },
      },
      required: ["uid"],
    },
  },
];

// Local executor for the allowed functions — called when model requests them
const executeFunction = async (functionName, args, uidContext) => {
  try {
    if (functionName === "find_jobs") {
      const { skills, location, employment_types } = args || {};
      const query = `${skills || "jobs"}${location ? ` in ${location}` : ""}`;
      const results = await findJobs({ query, employment_types });
      return results;
    } else if (functionName === "get_user_info") {
      const uid = args?.uid || uidContext;
      const user = await fetchUserPreferences(uid);
      return user || {};
    } else {
      return { error: "Unknown function requested." };
    }
  } catch (err) {
    console.error("Error executing function:", functionName, err);
    return { error: "Function execution failed." };
  }
};

// =================================================================
// API ENDPOINTS
// =================================================================

/**
 * 🎙️ Speech-to-Text Endpoint
 * Accepts a file upload field named "audio"
 */
app.post("/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Audio file missing." });
  if (!sttClient) return res.status(500).json({ error: "STT client not initialized." });

  const languageCode = req.body.languageCode || "en-IN";

  try {
    const audioBytes = fs.readFileSync(req.file.path).toString("base64");

    // Default config with common fallback values; you may adjust encoding/sampleRate based on file type
    const config = {
      encoding: "LINEAR16", // safer default for many uploads
      sampleRateHertz: 16000,
      languageCode,
      alternativeLanguageCodes: ["en-IN", "hi-IN", "pa-IN"],
      enableAutomaticPunctuation: true,
    };

    const audio = { content: audioBytes };
    const request = { audio, config };
    const [response] = await sttClient.recognize(request);
    const transcription = response.results?.map((r) => r.alternatives[0].transcript).join("\n") || "";
    res.json({ text: transcription });
  } catch (err) {
    console.error("STT Error:", err);
    res.status(500).json({ error: "Error transcribing audio" });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

/**
 * 💬 Chat endpoint (powerful prompt + function calling)
 * Expects: { message, history (optional), uid (required) }
 */
app.post("/chat", async (req, res) => {
  const { message, history, uid } = req.body;
  if (!uid) return res.status(400).json({ error: "User ID is missing." });

  try {
    // ---------- 1) Language detection (improved heuristics) ----------
    let detectedLanguage = "English";
    const text = (message || "").toString();

    // quick script-based detections for Indian languages
    if (/[\u0900-\u097F]/.test(text)) detectedLanguage = "Hindi";
    else if (/[\u0A00-\u0A7F]/.test(text)) detectedLanguage = "Punjabi";
    else if (/[\u0B80-\u0BFF]/.test(text)) detectedLanguage = "Tamil";
    else {
      const detectedLangCode = franc(text || "");
      if (detectedLangCode && detectedLangCode !== "und") {
        const langInfo = langs.where("3", detectedLangCode);
        if (langInfo) detectedLanguage = langInfo.name;
      }
    }

    // ---------- 2) personalization context ----------
    const userPrefs = await fetchUserPreferences(uid);
    let personalizationContext = "";
    if (userPrefs) {
      const name = userPrefs.name || "User";
      const skills = userPrefs.skills || "not provided";
      const jobRole = userPrefs.jobRole || "not specified";
      personalizationContext = `User profile: name=${name}; skills=${skills}; jobRole=${jobRole}.`;
    }

    // ---------- 3) Build system prompt ----------
    const systemPrompt = buildSystemPrompt({ detectedLanguage, personalizationContext });

    // ---------- 4) Build messages list ----------
    const transformedHistory = (Array.isArray(history) ? history : [])
      .filter((m) => m && m.message)
      .slice(-10) // keep last 10 messages for context
      .map((msg) => ({
        role: msg.type === 1 ? "assistant" : "user",
        content: msg.message,
      }));

    const messages = [
      { role: "system", content: systemPrompt },
      ...transformedHistory,
      { role: "user", content: text || "..." },
    ];

    // ---------- 5) Call OpenAI Chat Completion with functions (first pass) ----------
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        functions: functionsForOpenAI,
        function_call: "auto", // allow model to call functions
        max_tokens: 800,
        temperature: 0.2,
      }),
    });

    const openaiData = await openaiResp.json();
    if (!openaiData.choices || openaiData.choices.length === 0) {
      console.error("❌ OpenAI Error Response:", JSON.stringify(openaiData, null, 2));
      throw new Error("Invalid response from OpenAI.");
    }

    const firstChoice = openaiData.choices[0];
    const firstMessage = firstChoice.message;

    // ---------- 6) If model wants to call a function, run it and then call model again ----------
    if (firstMessage?.function_call) {
      const functionName = firstMessage.function_call.name;
      let functionArgs = {};
      try {
        functionArgs = JSON.parse(firstMessage.function_call.arguments || "{}");
      } catch (e) {
        console.warn("Could not parse function arguments:", e);
      }

      // Execute allowed functions securely
      const functionResult = await executeFunction(functionName, functionArgs, uid);

      // Append the model's function call and the tool's response, then ask for final reply
      const messagesWithTool = [
        ...messages,
        firstMessage, // model's request to call function
        {
          role: "tool",
          name: functionName,
          content: JSON.stringify(functionResult),
        },
      ];

      const finalResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: messagesWithTool,
          max_tokens: 800,
          temperature: 0.2,
        }),
      });

      const finalData = await finalResp.json();
      if (!finalData.choices || finalData.choices.length === 0) {
        console.error("❌ OpenAI Error on SECOND call:", JSON.stringify(finalData, null, 2));
        throw new Error("Invalid response from OpenAI on the second call.");
      }

      let assistantContent = finalData.choices[0].message.content || "";
      assistantContent = formatReply(assistantContent);

      // Optionally save chat snippet to Firestore for context (last message + reply)
      try {
        await db.collection("users").doc(uid).collection("chat_history").add({
          userMessage: text,
          assistantReply: assistantContent,
          functionCalled: functionName,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (err) {
        console.warn("Could not save chat history:", err);
      }

      return res.json({ reply: assistantContent, toolResult: functionResult });
    }

    // ---------- 7) No function call — return the assistant message ----------
    let assistantContent = firstMessage?.content || "";
    assistantContent = formatReply(assistantContent);

    // Save to chat history optionally
    try {
      await db.collection("users").doc(uid).collection("chat_history").add({
        userMessage: text,
        assistantReply: assistantContent,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn("Could not save chat history:", err);
    }

    res.json({ reply: assistantContent });
  } catch (err) {
    console.error("Error in /chat endpoint:", err);
    res.status(500).json({ error: "An error occurred processing your request." });
  }
});

/**
 * 🧩 Skill Gap Analysis Endpoint (improved safety & single-API use)
 */
app.get("/skills/analyze", async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: "User ID required." });

  try {
    const userPrefs = await fetchUserPreferences(uid);
    if (!userPrefs || !userPrefs.jobRole) {
      return res.status(404).json({ error: "User profile or job role not found." });
    }

    const userSkills = (userPrefs.skills || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
    const jobRole = userPrefs.jobRole;

    // Ask OpenAI for top skills — keep it short & controlled
    const system = `You are a concise career skills extractor. Respond ONLY with a comma-separated list of the top 8 technical skills for the provided job role.`;
    const userQ = `List 8 most important technical skills for the role: ${jobRole}. Respond ONLY with a comma-separated list (no commentary).`;

    const skillsResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userQ },
        ],
        max_tokens: 200,
        temperature: 0.0,
      }),
    });

    const skillsData = await skillsResp.json();
    const skillsText = skillsData.choices?.[0]?.message?.content || "";
    const requiredSkills = skillsText
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 8);

    const missingSkills = requiredSkills.filter((s) => !userSkills.includes(s));

    const learningResources = {};
    for (const skill of missingSkills) {
      // Minimal prompt to fetch a single high-quality public URL
      const resourcePrompt = `Provide one high-quality public URL for a tutorial or course to learn '${skill}'. Respond ONLY with the URL.`;
      try {
        const resourceResp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: AI_MODEL,
            messages: [{ role: "user", content: resourcePrompt }],
            max_tokens: 120,
            temperature: 0.1,
          }),
        });
        const resourceData = await resourceResp.json();
        const url = (resourceData.choices?.[0]?.message?.content || "").trim();
        if (url.startsWith("http")) learningResources[skill] = url;
      } catch (err) {
        console.warn("Resource fetch failed for skill:", skill, err);
      }
    }

    res.json({
      jobRole,
      requiredSkills,
      missingSkills,
      learningResources,
    });
  } catch (err) {
    console.error("Error in /skills/analyze endpoint:", err);
    res.status(500).json({ error: "Skill analysis failed." });
  }
});

/**
 * 💼 Job APIs (list, save, delete)
 */
app.get("/jobs", async (req, res) => {
  const { uid, q, employment_types } = req.query;
  let searchQuery = q;
  try {
    if (!searchQuery && uid) {
      const userPrefs = await fetchUserPreferences(uid);
      searchQuery = userPrefs ? `${userPrefs.skills || "jobs"} in ${userPrefs.location || "India"}` : "tech jobs in India";
    } else if (!searchQuery) {
      searchQuery = "jobs in India";
    }

    const jobsResult = await findJobs({ query: searchQuery, employment_types });
    res.json(jobsResult);
  } catch (err) {
    console.error("Error /jobs:", err);
    res.status(500).json({ error: "Error fetching jobs." });
  }
});

app.get("/users/:uid/saved-jobs", async (req, res) => {
  const { uid } = req.params;
  try {
    const snapshot = await db.collection("users").doc(uid).collection("saved_jobs").get();
    const savedJobs = snapshot.docs.map((doc) => doc.data());
    res.json(savedJobs);
  } catch (err) {
    console.error("Error fetching saved jobs:", err);
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
    console.error("Error saving job:", err);
    res.status(500).json({ error: "Could not save job." });
  }
});

app.delete("/users/:uid/saved-jobs/:jobId", async (req, res) => {
  const { uid, jobId } = req.params;
  try {
    await db.collection("users").doc(uid).collection("saved_jobs").doc(jobId).delete();
    res.status(200).json({ message: "Job unsaved" });
  } catch (err) {
    console.error("Error unsaving job:", err);
    res.status(500).json({ error: "Could not unsave job." });
  }
});

// =================================================================
// START SERVER
// =================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 RozgarAI Server running on port ${PORT}`));
