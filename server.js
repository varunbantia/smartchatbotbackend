import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import speech from "@google-cloud/speech";
import admin from "firebase-admin";
import { URL } from "url";

dotenv.config();

// =================================================================
// 1. CONFIGURATION & INITIALIZATION
// =================================================================

const app = express();
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });
const AI_MODEL = "gpt-3.5-turbo";
let sttClient;

try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: "smartchatbot-24e6b",
  });
  console.log("✅ Firebase Admin initialized successfully.");

  sttClient = new speech.SpeechClient();
  console.log("✅ Google Speech-to-Text client initialized successfully.");
} catch (err) {
  console.error("🔥 Google Cloud initialization failed:", err);
  process.exit(1);
}

// =================================================================
// 2. HELPER FUNCTIONS
// =================================================================

/**
 * Fetch user profile from Firestore
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
 * Search for live jobs using JSearch API
 */
const findJobs = async (params) => {
  try {
    const { skills, location } = params;
    const query = `${skills || "jobs"} in ${location || "India"}`;

    const url = new URL("https://jsearch.p.rapidapi.com/search");
    url.searchParams.append("query", query);
    url.searchParams.append("num_pages", "1");

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": process.env.JSEARCH_API_KEY,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      },
    });

    const result = await response.json();
    if (!result.data || result.data.length === 0) {
      return "I couldn't find any live job listings matching those criteria right now.";
    }

    // Transform the API data into a clean format for the AI
    const jobs = result.data.slice(0, 5).map((job) => ({
      title: job.job_title,
      company: job.employer_name,
      location: `${job.job_city || ""}${
        job.job_city && job.job_state ? ", " : ""
      }${job.job_state || ""}`,
      description: `Snippet: ${(job.job_description || "Not available").substring(
        0,
        150
      )}...`,
      applicationLink: job.job_apply_link,
    }));

    return jobs;
  } catch (error) {
    console.error("Error finding jobs via Jsearch API:", error);
    return "Sorry, I encountered an error while searching for live jobs.";
  }
};

// =================================================================
// 3. AI TOOLS
// =================================================================
const tools = [
  {
    type: "function",
    function: {
      name: "find_jobs",
      description:
        "Searches for real, live job listings from an external database based on criteria like skills or location.",
      parameters: {
        type: "object",
        properties: {
          skills: {
            type: "string",
            description: "Job title or skills to search for, e.g., 'Python developer'",
          },
          location: {
            type: "string",
            description: "Desired job location, e.g., 'Bengaluru'",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_info",
      description: "Retrieves the current user's profile information from Firestore.",
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
  if (!sttClient)
    return res.status(500).json({ error: "Google Speech client not initialized." });

  const languageCode = req.body.languageCode || "en-IN";

  try {
    const audioBytes = fs.readFileSync(req.file.path).toString("base64");

    const config = {
      encoding: "AMR",
      sampleRateHertz: 8000,
      languageCode: languageCode,
      alternativeLanguageCodes: ["en-IN", "hi-IN", "pa-IN"],
    };

    const [response] = await sttClient.recognize({
      audio: { content: audioBytes },
      config,
    });
    const transcription =
      response.results?.map((r) => r.alternatives[0].transcript).join("\n") || "";

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
  if (!uid) return res.status(400).json({ error: "User ID (uid) is missing." });

  try {
    const userPrefs = await fetchUserPreferences(uid);
    let personalizationContext = userPrefs
      ? `The user's name is ${userPrefs.name}, and their skills include ${userPrefs.skills}.`
      : "";
    const languageInstruction = `Respond in ${language || "English"}.`;

    const systemPrompt = `You are RozgarAI, a helpful AI career advisor.
- When a user asks you to find jobs, use the 'find_jobs' tool.
- Present jobs conversationally. For each job, provide: Title, Company, Location, and Application Link.
- If asked for details, guide the user to the application link.
- ${personalizationContext} ${languageInstruction}`;

    const transformedHistory = (Array.isArray(history) ? history : [])
      .filter((msg) => msg.message)
      .map((msg) => {
        const role = msg.type === 1 ? "assistant" : "user";
        return { role, content: msg.message };
      });

    const messages = [
      { role: "system", content: systemPrompt },
      ...transformedHistory,
      { role: "user", content: message || "..." },
    ];

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        tools,
        tool_choice: "auto",
      }),
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

      if (functionName === "find_jobs") {
        toolResult = await findJobs(functionArgs);
      } else if (functionName === "get_user_info") {
        toolResult = await fetchUserPreferences(uid);
      } else {
        toolResult = { error: "Unknown function." };
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: finalMessages,
        }),
      });
      const finalData = await finalResponse.json();
      res.json({ reply: finalData.choices[0].message.content });
    } else {
      res.json({ reply: firstResponseMsg.content });
    }
  } catch (err) {
    console.error("Error in /chat endpoint:", err);
    res.status(500).json({ error: "An error occurred." });
  }
});

// =================================================================
// 5. START SERVER
// =================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
