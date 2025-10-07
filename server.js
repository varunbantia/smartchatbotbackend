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
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });
const AI_MODEL = "gpt-3.5-turbo";

let sttClient;

// ✅ Parse Firebase credentials from ENV
const firebaseServiceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON
);

// ✅ Parse Google STT credentials from ENV
const googleServiceAccount = JSON.parse(
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
);

try {
  // Firebase Initialization
  admin.initializeApp({
    credential: admin.credential.cert(firebaseServiceAccount),
    projectId: firebaseServiceAccount.project_id,
  });
  console.log("✅ Firebase Admin initialized successfully.");

  // Google Cloud STT Initialization
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
// 2. HELPER FUNCTIONS
// =================================================================

const fetchUserPreferences = async (uid) => {
  if (!uid) return null;
  try {
    const userDoc = await db.collection("users").doc(uid).get();
    return userDoc.exists ? userDoc.data() : null;
  } catch (error) {
    console.error("Error fetching user from Firestore:", error);
    return null;
  }
};

const findJobs = async (params) => {
  try {
    const { query, employment_types } = params;

    const url = new URL("https://jsearch.p.rapidapi.com/search");
    url.searchParams.append("query", query);
    if (employment_types) {
      url.searchParams.append("employment_types", employment_types.toUpperCase());
    }
    url.searchParams.append("num_pages", "1");

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": process.env.JSEARCH_API_KEY,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      },
    });

    const result = await response.json();
    if (!result.data || result.data.length === 0) return [];

    const jobs=result.data.slice(0, 5).map((job) => ({
      job_id: job.job_id,
      title: job.job_title,
      company: job.employer_name,
      location: `${job.job_city || ''}${job.job_city && job.job_state ? ','  : ''}${job.job_state || ''}`.trim(),
      description: job.job_description || 'No description available.',
      applicationLink:
        job.job_apply_link ||
        `https://www.google.com/search?q=${encodeURIComponent(
          job.job_title +  'at' + job.employer_name
        )}`,
    }));
    return jobs;
  } catch (error) {
    console.error("Error finding jobs via Jsearch API:", error);
    return [];
  }
};

// =================================================================
// 3. AI TOOLS CONFIGURATION
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

            description:
              "Job title or skills to search for, e.g., 'Python developer'",
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

      description:
        "Retrieves the current user's profile information from Firestore.",

      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// =================================================================
// 4. API ENDPOINTS
// =================================================================

/**
 * 🎙️ Speech-to-Text Endpoint
 */
app.post("/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Audio file missing." });
  if (!sttClient) return res.status(500).json({ error: "STT client not initialized." });

  const languageCode = req.body.languageCode || "en-IN";

  try {
    const audioBytes = fs.readFileSync(req.file.path).toString("base64");
    const config = {
      encoding: "AMR",
      sampleRateHertz: 8000,
      languageCode,
      alternativeLanguageCodes: ["en-IN", "hi-IN", "pa-IN"],
    };

    const audio = { content: audioBytes };
    const request = { audio, config };
    const [response] = await sttClient.recognize(request);
    const transcription =
      response.results?.map((r) => r.alternatives[0].transcript).join("\n") || "";
    res.json({ text: transcription });
  } catch (err) {
    console.error("STT Error:", err);
    res.status(500).json({ error: "Error transcribing audio" });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

/**
 * 💬 Chat Endpoint (Multilingual)
 */
app.post("/chat", async (req, res) => {
  const { message, history, uid } = req.body;
  if (!uid) return res.status(400).json({ error: "User ID is missing." });

  try {
    // ✅ Auto-detect message language
    let detectedLangCode = franc(message || "");
    let detectedLanguage = "English";
    if (detectedLangCode !== "und") {
      const langInfo = langs.where("3", detectedLangCode);
      if (langInfo) detectedLanguage = langInfo.name;
    }

    const userPrefs = await fetchUserPreferences(uid);
    let personalizationContext = userPrefs
      ? `The user's name is ${userPrefs.name}, and their skills include ${userPrefs.skills}.`
      : "";

    const systemPrompt = `You are RozgarAI, a helpful AI career advisor.
You MUST use the 'find_jobs' tool for job-related questions.
Always respond in ${detectedLanguage}.
When presenting jobs, you MUST use the exact data from the tool.
Guide users to the application link for more information. ${personalizationContext}
Do not invent job data; use exact data returned by the tool.
${personalizationContext}`;

    const transformedHistory = (Array.isArray(history) ? history : [])
      .filter((msg) => msg.message)
      .map((msg) => ({ role: msg.type === 1 ? "assistant" : "user", content: msg.message }));

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

      if (functionName === "find_jobs") {
        const { skills, location } = functionArgs;
        const searchQuery = `${skills || 'jobs'}${location ? ` in ${location}` : ''}`;
        toolResult = await findJobs({ query: searchQuery });
      } else if (functionName === "get_user_info") {
        toolResult = await fetchUserPreferences(uid);
      } else {
        toolResult = { error: "Unknown function." };
      }

      const finalMessages = [
        ...messages,
        firstResponseMsg,
        { tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(toolResult) },
      ];

      const finalResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model: AI_MODEL, messages: finalMessages }),
      });
      const finalData = await finalResponse.json();
      if (!finalData.choices || finalData.choices.length === 0) {
                console.error("❌ OpenAI Error on SECOND call:", JSON.stringify(finalData, null, 2));
                throw new Error("Invalid response from OpenAI on the second call.");
            }
      res.json({ reply: finalData.choices[0].message.content});
    } else {
      res.json({ reply: firstResponseMsg.content });
    }
  } catch (err) {
    console.error("Error in /chat endpoint:", err);
    res.status(500).json({ error: "An error occurred." });
  }
});

/**
 * 🧩 Skill Gap Analysis Endpoint
 */
app.get("/skills/analyze", async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: "User ID required." });

  try {
    const userPrefs = await fetchUserPreferences(uid);
    if (!userPrefs || !userPrefs.jobRole) {
      return res.status(404).json({ error: "User profile or job role not found." });
    }

    const userSkills = (userPrefs.skills || "").toLowerCase().split(',').map((s) => s.trim());
    const jobRole = userPrefs.jobRole;

        const skillsQuestion = `List the top 8 most important technical skills for a '${jobRole}'. Respond ONLY with a comma-separated list (e.g., skill1,skill2,skill3).`;
    const skillsResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: "gpt-3.5-turbo", messages: [{ role: "user", content: skillsQuestion }] }),
    });
    const skillsData = await skillsResponse.json();
    const requiredSkillsText = skillsData.choices[0].message.content;
    const requiredSkills = requiredSkillsText.toLowerCase().split(',').map((s) => s.trim());
    const missingSkills = requiredSkills.filter(skill => !userSkills.includes(skill));

    const learningResources = {};
    for (const skill of missingSkills) {
            const resourceQuestion = `Provide one high-quality, public URL for a tutorial or course to learn '${skill}'. Respond ONLY with the URL.`;
      const resourceResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model: "gpt-3.5-turbo", messages: [{ role: "user", content: resourceQuestion }] }),
      });
      const resourceData = await resourceResponse.json();
      const url = resourceData.choices[0].message.content.trim();
      if (url.startsWith("http")) learningResources[skill] = url;
    }

res.json({
            jobRole: jobRole,
            requiredSkills: requiredSkills,
            missingSkills: missingSkills,
            learningResources: learningResources,
        });  } catch (err) {
    console.error("Error in /skills/analyze endpoint:", err);
    res.status(500).json({ error: "Skill analysis failed." });
  }
});

/**
 * 💼 Job APIs (save, list, delete)
 */
app.get("/jobs", async (req, res) => {
  const { uid, q, employment_types } = req.query;
  let searchQuery = q;
  try {
    if (!searchQuery && uid) {
      const userPrefs = await fetchUserPreferences(uid);
      searchQuery = userPrefs
        ? `${userPrefs.skills || 'jobs'} in ${userPrefs.location || 'India'}`
        : 'tech jobs in India';
    } else if (!searchQuery) {
      searchQuery = 'jobs in India';
    }
    const jobsResult = await findJobs({ query: searchQuery, employment_types });
    res.json(jobsResult);
  } catch (err) {
    res.status(500).json({ error: "Error fetching jobs." });
  }
});

app.get("/users/:uid/saved-jobs", async (req, res) => {
  const { uid } = req.params;
  try {
    const snapshot = await db.collection("users").doc(uid).collection("saved_jobs").get();
    const savedJobs = snapshot.docs.map((doc) => doc.data());
    res.json(savedJobs);
  } catch (error) {
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
  } catch (error) {
    res.status(500).json({ error: "Could not save job." });
  }
});

app.delete("/users/:uid/saved-jobs/:jobId", async (req, res) => {
  const { uid, jobId } = req.params;
  try {
    await db.collection("users").doc(uid).collection("saved_jobs").doc(jobId).delete();
    res.status(200).json({ message: "Job unsaved" });
  } catch (error) {
    res.status(500).json({ error: "Could not unsave job." });
  }
});

// =================================================================
// 5. START SERVER
// =================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
