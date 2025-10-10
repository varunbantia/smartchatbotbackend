// server.js — RozgarAI backend (OpenAI Tools API fixed)
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

const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini"; // modern model

let sttClient;

// FIREBASE & GOOGLE STT CREDENTIALS
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
  console.log("✅ Firebase & Google STT initialized.");
} catch (err) {
  console.error("🔥 Init failed:", err);
  process.exit(1);
}

const db = admin.firestore();

// =================================================================
// HELPERS
// =================================================================
const fetchUserPreferences = async (uid) => {
  try {
    if (!uid) return null;
    const doc = await db.collection("users").doc(uid).get();
    return doc.exists ? doc.data() : null;
  } catch (err) {
    console.error("fetchUserPreferences error:", err);
    return null;
  }
};

const findJobs = async ({ query, employment_types } = {}) => {
  try {
    if (!process.env.JSEARCH_API_KEY) return [];
    const url = new URL("https://jsearch.p.rapidapi.com/search");
    url.searchParams.append("query", query || "jobs");
    if (employment_types)
      url.searchParams.append("employment_types", employment_types.toUpperCase());
    url.searchParams.append("num_pages", "1");
    const resp = await fetch(url.toString(), {
      headers: {
        "X-RapidAPI-Key": process.env.JSEARCH_API_KEY,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      },
    });
    const data = await resp.json();
    if (!data?.data) return [];
    return data.data.slice(0, 5).map((job) => ({
      job_id: job.job_id,
      title: job.job_title,
      company: job.employer_name,
      location: `${job.job_city || ""}${job.job_city && job.job_state ? "," : ""}${job.job_state || ""}`.trim(),
      description: job.job_description || "No description.",
      applicationLink:
        job.job_apply_link ||
        `https://www.google.com/search?q=${encodeURIComponent(
          `${job.job_title} at ${job.employer_name}`
        )}`,
    }));
  } catch (err) {
    console.error("findJobs error:", err);
    return [];
  }
};

const formatReply = (text) => {
  if (!text) return "";
  return text
    .replace(/\*\*(.*?)\*\*/g, "\n\n>>> $1\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const buildSystemPrompt = ({ detectedLanguage, personalizationContext }) => `
You are RozgarAI — an expert multilingual career mentor, technical advisor, and growth companion.

OBJECTIVES:
1. Help users get jobs, learn skills, prepare for interviews, and grow their careers.
2. Use tools when job or user data is required.
3. Be clear, factual, and encouraging.
4. Respond fully in ${detectedLanguage}.
5. Format answers with sections like "Overview", "Next Steps", "Resources".

${personalizationContext || ""}
`;

// =================================================================
// TOOL DEFINITIONS (modern API format)
// =================================================================
const toolsForOpenAI = [
  {
    type: "function",
    function: {
      name: "find_jobs",
      description: "Search for live job listings based on skills, title, or location.",
      parameters: {
        type: "object",
        properties: {
          skills: { type: "string" },
          location: { type: "string" },
          employment_types: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_info",
      description: "Retrieve user profile info from Firestore.",
      parameters: {
        type: "object",
        properties: {
          uid: { type: "string" },
        },
        required: ["uid"],
      },
    },
  },
];

const executeTool = async (name, args, uid) => {
  try {
    if (name === "find_jobs") {
      const { skills, location, employment_types } = args || {};
      const query = `${skills || "jobs"}${location ? ` in ${location}` : ""}`;
      return await findJobs({ query, employment_types });
    }
    if (name === "get_user_info") {
      const user = await fetchUserPreferences(args?.uid || uid);
      return user || {};
    }
    return { error: "Unknown tool" };
  } catch (err) {
    console.error("Tool error:", err);
    return { error: "Tool execution failed" };
  }
};

// =================================================================
// ENDPOINTS
// =================================================================

// 🎙️ Speech to Text
app.post("/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Audio file missing" });
  try {
    const audioBytes = fs.readFileSync(req.file.path).toString("base64");
    const config = {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode: req.body.languageCode || "en-IN",
      enableAutomaticPunctuation: true,
    };
    const [response] = await sttClient.recognize({ audio: { content: audioBytes }, config });
    const transcription =
      response.results?.map((r) => r.alternatives[0].transcript).join("\n") || "";
    res.json({ text: transcription });
  } catch (err) {
    console.error("STT error:", err);
    res.status(500).json({ error: "Speech-to-text failed" });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// 💬 Chat
app.post("/chat", async (req, res) => {
  const { message, history, uid } = req.body;
  if (!uid) return res.status(400).json({ error: "User ID required." });

  try {
    let detectedLanguage = "English";
    const text = message?.toString() || "";
    if (/[\u0900-\u097F]/.test(text)) detectedLanguage = "Hindi";
    else if (/[\u0A00-\u0A7F]/.test(text)) detectedLanguage = "Punjabi";
    else {
      const langCode = franc(text);
      if (langCode && langCode !== "und") {
        const info = langs.where("3", langCode);
        if (info) detectedLanguage = info.name;
      }
    }

    const prefs = await fetchUserPreferences(uid);
    const personalizationContext = prefs
      ? `User: ${prefs.name || "User"}, Skills: ${prefs.skills || "none"}, Role: ${
          prefs.jobRole || "not specified"
        }.`
      : "";

    const systemPrompt = buildSystemPrompt({ detectedLanguage, personalizationContext });
    const chatHistory = (history || [])
      .filter((m) => m?.message)
      .slice(-10)
      .map((m) => ({
        role: m.type === 1 ? "assistant" : "user",
        content: m.message,
      }));

    const messages = [
      { role: "system", content: systemPrompt },
      ...chatHistory,
      { role: "user", content: text },
    ];

    // === FIRST CALL ===
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        tools: toolsForOpenAI,
        tool_choice: "auto",
        temperature: 0.3,
      }),
    });

    const openaiData = await openaiResp.json();
    if (!openaiData?.choices?.length) throw new Error("Empty OpenAI response.");

    const msg = openaiData.choices[0].message;

    // === IF TOOL CALL ===
    if (msg.tool_calls?.length) {
      const toolCall = msg.tool_calls[0];
      const { name, arguments: rawArgs } = toolCall.function;
      let args = {};
      try {
        args = JSON.parse(rawArgs || "{}");
      } catch {}
      const result = await executeTool(name, args, uid);

      const messagesWithTool = [
        ...messages,
        msg, // model message with tool_calls
        {
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: JSON.stringify(result),
        },
      ];

      // === SECOND CALL ===
      const finalResp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: messagesWithTool,
          temperature: 0.3,
        }),
      });

      const finalData = await finalResp.json();
      if (!finalData?.choices?.length) throw new Error("Empty second OpenAI response.");
      let reply = formatReply(finalData.choices[0].message.content);

      await db.collection("users").doc(uid).collection("chat_history").add({
        userMessage: text,
        assistantReply: reply,
        functionCalled: name,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      return res.json({ reply, toolResult: result });
    }

    // === NO TOOL CALL ===
    let reply = formatReply(msg.content);
    await db.collection("users").doc(uid).collection("chat_history").add({
      userMessage: text,
      assistantReply: reply,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ reply });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Chat processing failed." });
  }
});

// 💼 Job APIs
app.get("/jobs", async (req, res) => {
  const { uid, q, employment_types } = req.query;
  try {
    let query = q;
    if (!query && uid) {
      const prefs = await fetchUserPreferences(uid);
      query = `${prefs?.skills || "jobs"} in ${prefs?.location || "India"}`;
    } else if (!query) query = "jobs in India";
    const data = await findJobs({ query, employment_types });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Job fetch failed" });
  }
});

// Saved jobs
app.get("/users/:uid/saved-jobs", async (req, res) => {
  try {
    const snap = await db.collection("users").doc(req.params.uid).collection("saved_jobs").get();
    res.json(snap.docs.map((d) => d.data()));
  } catch {
    res.status(500).json({ error: "Failed to fetch saved jobs" });
  }
});
app.post("/users/:uid/saved-jobs", async (req, res) => {
  const { uid } = req.params;
  const job = req.body;
  if (!job.job_id) return res.status(400).json({ error: "job_id missing" });
  try {
    await db.collection("users").doc(uid).collection("saved_jobs").doc(job.job_id).set(job);
    res.status(201).json({ message: "Job saved" });
  } catch {
    res.status(500).json({ error: "Save failed" });
  }
});
app.delete("/users/:uid/saved-jobs/:jobId", async (req, res) => {
  const { uid, jobId } = req.params;
  try {
    await db.collection("users").doc(uid).collection("saved_jobs").doc(jobId).delete();
    res.json({ message: "Job unsaved" });
  } catch {
    res.status(500).json({ error: "Unsave failed" });
  }
});

// =================================================================
// START SERVER
// =================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 RozgarAI Server running on port ${PORT}`));
