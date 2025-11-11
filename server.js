import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import path from "path";
import speech from "@google-cloud/speech";
import admin from "firebase-admin";
import { URL } from "url";
import { franc } from "franc";
import langs from "langs";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";

dotenv.config();

// =================================================================
// 1. CONFIGURATION & INITIALIZATION
// =================================================================

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Ensure the uploads directory exists
    const uploadDir = "uploads/";
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const extension = path.extname(file.originalname);
    cb(null, file.fieldname + "-" + uniqueSuffix + extension);
  },
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});
const app = express();
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

const AI_MODEL = process.env.OPENAI_MODEL || "gpt-3.5-turbo";
let sttClient = null;

const firebaseServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : null;
const googleServiceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
  : null;

try {
  if (!firebaseServiceAccount)
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
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
  if (!googleServiceAccount)
    throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS_JSON");
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
}
let docAIClient = null;
const docAIprojectId = googleServiceAccount?.project_id;
const docAIlocation = process.env.DOC_AI_LOCATION || "us";
const docAIprocessorId = process.env.DOC_AI_PROCESSOR_ID;

try {
  if (!googleServiceAccount)
    throw new Error("Missing Google credentials JSON for Document AI");
  if (!docAIprojectId || !docAIprocessorId)
    throw new Error(
      "Missing project_id in credentials or DOC_AI_PROCESSOR_ID in env vars"
    );

  docAIClient = new DocumentProcessorServiceClient({
    credentials: {
      client_email: googleServiceAccount.client_email,
      private_key: googleServiceAccount.private_key,
    },
    projectId: docAIprojectId,
  });
  console.log("✅ Google Document AI client initialized successfully.");
} catch (err) {
  console.error("🔥 Google Document AI initialization failed:", err);
}
const db = admin.firestore();

// =================================================================
// 2. HELPERS
// =================================================================
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function extractResumeText(filePath, fileMimeType) {
  if (!docAIClient) {
    throw new Error("Document AI client is not initialized.");
  }
  if (!docAIprojectId || !docAIlocation || !docAIprocessorId) {
    throw new Error("Document AI configuration is missing.");
  }
  console.log(
    `Sending file to Document AI OCR: ${filePath}, MIME: ${fileMimeType}`
  );

  try {
    const content = fs.readFileSync(filePath).toString("base64");
    const name = `projects/${docAIprojectId}/locations/${docAIlocation}/processors/${docAIprocessorId}`;
    const request = {
      name: name,
      rawDocument: {
        content: content,
        mimeType: fileMimeType,
      },
    };

    console.log("Calling Document AI OCR processDocument...");
    const [result] = await docAIClient.processDocument(request);
    const { document } = result;

    if (!document || !document.text) {
      console.warn("Document AI OCR processed the file but returned no text.");
      throw new Error("Could not extract text from the document using OCR.");
    }

    console.log(
      `Extracted ${document.text.length} characters via Document AI OCR.`
    );
    return document.text;
  } catch (error) {
    console.error(`Error calling Google Document AI OCR:`, error);
    const errorMessage =
      error.details || error.message || "Unknown Document AI OCR error";
    throw new Error(`Failed to process document with OCR: ${errorMessage}`);
  }
}
async function getUserStats(uid) {
  if (!uid) return null;
  const statsRef = db.collection("user_stats").doc(uid);
  const doc = await statsRef.get();

  if (!doc.exists) {
    const defaultStats = {
      hrAnswersCompleted: 0,
      starStoriesSaved: 0,
      techQuestionsPracticed: 0,
      mockInterviewsRecorded: 0,
      companyNotesCreated: 0,
    };
    await statsRef.set(defaultStats);
    return defaultStats;
  }
  return doc.data();
}
async function getResumeFeedback(resumeText) {
  if (!resumeText || resumeText.trim().length < 50) {
    throw new Error("Extracted resume text is too short or empty.");
  }

  const analysisPrompt = `
You are an **expert career strategist, HR consultant, and professional resume reviewer** with 15+ years of experience helping candidates optimize their resumes for top global employers (FAANG, Fortune 500, startups, and government roles).

Your task: Critically analyze the following resume text and produce a **comprehensive, structured report** in clear Markdown format. Focus on professionalism, clarity, ATS compatibility, and impact.

Resume Text:
---
${resumeText}
---

# Resume Overview
Provide a concise summary of the resume. Identify the main sections (e.g., Summary, Experience, Skills, Education, Projects, Certifications).
- Determine the **resume format type**: Chronological, Functional, or Combination.
- Highlight the **industry or job role** it appears suited for.
- Assess overall tone and presentation quality (e.g., formal, technical, academic, creative).

# Strengths & Positive Highlights
List 4-6 strengths observed in the resume. Focus on clarity, structure, tone, and presentation.
Use bullet points and explain **why** each strength adds value.

# Weaknesses & Missing Elements
List the key weaknesses or gaps (missing sections, poor formatting, lack of achievements, etc.).
Mention **which essential sections** (Contact Info, Summary, Skills, Experience, Education, Projects, Certifications) are missing or incomplete.

# Section-by-Section Evaluation
For each section (if present), evaluate:
- **Summary:** Does it clearly define professional identity and career goals?
- **Skills:** Are they specific, relevant, and ATS-friendly? Are they grouped logically?
- **Experience:** Are roles described with action verbs and measurable outcomes?
- **Education:** Is the format consistent and relevant?
- **Projects/Certifications:** Are they meaningful and add credibility?

# ATS & Keyword Optimization
Analyze whether the resume is likely to **pass an Applicant Tracking System (ATS)** scan.
- Identify missing **industry-relevant keywords**.
- Suggest 5–10 keywords the candidate should integrate based on their likely field.

# Language, Clarity & Impact
Critique the tone, grammar, and flow:
- Is the writing concise and professional?
- Are bullet points impactful?
- Highlight overused phrases or filler words.
- Suggest stronger verbs or phrasing.

# Actionable Recommendations
Provide **5–7 detailed, actionable suggestions** to enhance the resume’s quality and impact.
Examples: improve structure, add measurable metrics, rewrite summary, etc.
Each recommendation should start with a bold heading (e.g., **Add Measurable Results**) followed by 1–2 lines of explanation.

# Final Verdict
Summarize your professional opinion in 3–5 sentences:
- Overall impression (Professional / Needs Major Work / Excellent)
- Estimated ATS score (out of 100)
- Hiring-readiness level (e.g., Ready for submission, Needs moderate revisions, Major rewrite needed)
`;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: "user", content: analysisPrompt }],
        temperature: 0.5,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data?.choices?.[0]?.message?.content) {
      console.error(
        "OpenAI error during feedback generation:",
        JSON.stringify(data, null, 2)
      );
      throw new Error("Failed to get analysis from AI model.");
    }
    console.log("AI analysis successful.");
    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error calling OpenAI for resume feedback:", error);
    throw new Error("Could not get feedback from AI.");
  }
}

function detectLanguageSimple(message) {
  if (!message || typeof message !== "string" || message.trim() === "")
    return "English";
  if (/[\u0900-\u097F]/.test(message)) return "Hindi";
  if (/[\u0A00-\u0A7F]/.test(message)) return "Punjabi";
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
  } catch (e) {}
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

async function getCompanyLogo(companyName, jsearchLogo) {
  if (jsearchLogo) return jsearchLogo;
  if (!companyName || companyName.trim() === "") return null;
  const companyKey = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/inc|llc|ltd|pvt/g, "");
  if (!companyKey) return null;
  const logoRef = db.collection("company_logos").doc(companyKey);
  try {
    const logoDoc = await logoRef.get();
    if (logoDoc.exists) {
      console.log(`[Cache Hit] Found logo for: ${companyName}`);
      return logoDoc.data().url;
    }
    console.log(`[Cache Miss] Guessing logo for: ${companyName}`);
    const domain = `${companyKey}.com`;
    const guessedUrl = `https://img.logo.dev/${domain}`;
    logoRef
      .set({
        url: guessedUrl,
        companyName: companyName,
        lastGuessed: admin.firestore.FieldValue.serverTimestamp(),
      })
      .catch((err) => console.error("Failed to save logo to cache:", err));
    return guessedUrl;
  } catch (err) {
    console.error("Error in getCompanyLogo:", err);
    return null;
  }
}

function formatSalary(job) {
  if (!job) return "Not Disclosed";
  const min = job.job_min_salary;
  const max = job.job_max_salary;
  const currency = job.job_salary_currency || "";
  const period = job.job_salary_period
    ? `per ${job.job_salary_period.toLowerCase()}`
    : "";

  if (min && max) {
    return `${currency} ${min.toLocaleString()} - ${max.toLocaleString()} ${period}`;
  } else if (min) {
    return `${currency} ${min.toLocaleString()} ${period}`;
  } else if (max) {
    return `${currency} ${max.toLocaleString()} ${period}`;
  }
  return "Not Disclosed";
}

function getJobType(job) {
  if (!job) return "N/A";
  if (job.job_is_remote) return "Remote";
  const empType = job.job_employment_type;
  if (empType) {
    return empType.charAt(0) + empType.slice(1).toLowerCase();
  }
  return "On-site";
}

function cleanJobDescription(description) {
  if (!description || typeof description !== "string") {
    return "No description available.";
  }

  const uniqueParagraphs = new Set();

  const paragraphs = description.split(/\n\s*\n/);

  for (const para of paragraphs) {
    const reFlowedParagraph = para.replace(/\n/g, " ").trim();

    if (reFlowedParagraph) {
      uniqueParagraphs.add(reFlowedParagraph);
    }
  }

  return Array.from(uniqueParagraphs).join("\n\n");
}

function getExperience(job) {
  if (!job) return "Not Disclosed";

  if (job.job_required_experience) {
    const exp = job.job_required_experience;
    if (exp.no_experience_required) return "Entry Level";

    const months = exp.required_experience_in_months;
    if (months) {
      if (months < 12) return `${months} months`;
      const years = (months / 12).toFixed(1).replace(".0", "");
      return `${years}+ years`;
    }
  }

  if (job.job_description) {
    const description = job.job_description.toLowerCase();

    const regex =
      /(\d[\d.,-]*\+?)\s*(to|-)?\s*(\d[\d.,-]*\+?)?\s*(year|yr|month)s?/i;
    const match = description.match(regex);

    if (match) {
      if (match[3]) {
        return `${match[1]}-${match[3]} ${match[4]}s`;
      } else {
        return `${match[1]} ${match[4]}s`;
      }
    }

    if (
      description.includes("entry level") ||
      description.includes("no experience")
    ) {
      return "Entry Level";
    }
  }

  return "Not Disclosed";
}
const findJobs = async (params) => {
  console.log("[findJobs] Checking API Key...");
  if (!process.env.JSEARCH_API_KEY) {
    console.error(
      "[findJobs] FATAL: JSEARCH_API_KEY is NOT loaded from .env file."
    );
    return [];
  }
  console.log("[findJobs] API Key is loaded.");

  try {
    // ⬇️ MODIFICATION 1: Get jobLimit, default to 50 if not provided
    const { query, employment_types, jobLimit = 50 } = params || {};
    if (!query || query.trim() === "") return [];

    const BASE_URL = "https://jsearch.p.rapidapi.com/search";

    // ⬇️ MODIFICATION 2: Calculate pages based on 10 jobs/page
    // If jobLimit is 5, this fetches 1 page. If 50, it fetches 5 pages.
    const totalPages = Math.ceil(jobLimit / 10);
    const allResults = [];

    console.log(
      `[findJobs] Starting multi-page fetch for query: "${query}", pages: ${totalPages}`
    );

    for (let page = 1; page <= totalPages; page++) {
      const url = new URL(BASE_URL);
      url.searchParams.append("query", query);
      url.searchParams.append("page", page.toString());
      url.searchParams.append("num_pages", "1");

      console.log(`[findJobs] Fetching Page ${page} → ${url.toString()}`);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "X-RapidAPI-Key": process.env.JSEARCH_API_KEY,
          "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
        },
        timeout: 10000,
      });

      console.log(
        `[findJobs] Page ${page} status:`,
        response.status,
        response.statusText
      );

      if (!response.ok) {
        console.warn(
          `[findJobs] Warning: Page ${page} returned HTTP ${response.status}. Skipping...`
        );
        continue;
      }

      const result = await response.json();
      if (!result?.data || result.data.length === 0) {
        console.log(
          `[findJobs] Page ${page} returned no data. Stopping pagination.`
        );
        break;
      }

      allResults.push(...result.data);
      console.log(
        `[findJobs] Page ${page} fetched ${result.data.length} jobs.`
      );
    }

    if (allResults.length === 0) {
      console.log("[findJobs] No jobs found after fetching all pages.");
      return [];
    }
    const jobs = await Promise.all(
      // ⬇️ MODIFICATION 3: Slice the final array to the exact jobLimit
      allResults.slice(0, jobLimit).map(async (job) => {
        const logoUrl = await getCompanyLogo(
          job.employer_name,
          job.employer_logo
        );
        const location = `${job.job_city || ""}${
          job.job_city && job.job_state ? ", " : ""
        }${job.job_state || ""}`.trim();
        const cleanDescription = cleanJobDescription(job.job_description);
        return {
          job_id: job.job_id,
          title: job.job_title,
          company: job.employer_name,
          companyLogoUrl: logoUrl,
          location: location || "N/A",
          description: cleanDescription || "No description available.",
          applicationLink:
            job.job_apply_link ||
            `https://www.google.com/search?q=${encodeURIComponent(
              job.job_title + " " + job.employer_name
            )}`,
          salary: formatSalary(job),
          jobType: getJobType(job),
          experience: getExperience(job),
        };
      })
    );

    console.log(
      `[findJobs] ✅ Success: Found ${jobs.length} jobs (limit was ${jobLimit}).`
    );
    return jobs;
  } catch (err) {
    console.error(
      "[findJobs] ❌ CRITICAL ERROR during fetch:",
      err.name,
      err.message
    );
    return [];
  }
};

// =================================================================
// 3. Tools configuration
// =================================================================

const tools = [
  {
    type: "function",
    function: {
      name: "find_jobs",
      description:
        "Searches for real, live job listings from an external database based on a search query.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Full search query (e.g., 'android developer in Bengaluru')",
          },
          employment_types: {
            type: "string",
            description: "Hiring type: FULLTIME, CONTRACTOR, INTERN, etc.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_info",
      description: "Retrieves the user's profile stored in Firestore.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// =================================================================
// 4. API Endpoints
// =================================================================

app.post("/analyze-resume", upload.single("resumeFile"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No resume file uploaded." });
  }
  const filePath = req.file.path;
  const fileMimeType = req.file.mimetype;
  const originalFilename = req.file.originalname;
  console.log(
    `Received resume file for analysis: ${filePath} (Original: ${originalFilename}, MIME: ${fileMimeType})`
  );

  const allowedMimeTypes = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/gif",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  if (!allowedMimeTypes.includes(fileMimeType)) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.warn(`Unsupported MIME type for Document AI OCR: ${fileMimeType}`);
    return res
      .status(400)
      .json({ error: `Unsupported file type: ${fileMimeType}.` });
  }

  try {
    const resumeText = await extractResumeText(filePath, fileMimeType);

    const analysisResult = await getResumeFeedback(resumeText);

    res.json({ analysisResult: analysisResult });
  } catch (error) {
    console.error("Error during resume analysis:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to analyze resume." });
  } finally {
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) console.error(`Error deleting temp file ${filePath}:`, err);
        else console.log(`Deleted temp file: ${filePath}`);
      });
    }
  }
});

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "SmartChatbot backend running" });
});

app.post("/stt", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Audio file missing." });
  if (!sttClient)
    return res.status(500).json({ error: "STT client not initialized." });
  const providedLang = (req.body.languageCode || "").trim();
  const languageCode = providedLang || "en-IN";
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
      response.results?.map((r) => r.alternatives[0].transcript).join("\n") ||
      "";
    const detectedLanguage = detectLanguageSimple(transcription || "");
    return res.json({ text: transcription, detectedLanguage });
  } catch (err) {
    console.error("STT Error:", err);
    return res.status(500).json({ error: "Error transcribing audio." });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

app.post("/chat", async (req, res) => {
  try {
    const { message, history, uid } = req.body;
    if (!uid) return res.status(400).json({ error: "User ID is missing." });
    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ error: "Message is empty." });
    }
    const detectedLanguage = detectLanguageSimple(message);
    console.log("Detected language:", detectedLanguage);
    const userPrefs = await fetchUserPreferences(uid);
    const personalizationContext = userPrefs
      ? `User name: ${userPrefs.name || "N/A"}. Skills: ${
          userPrefs.skills || "N/A"
        }. Location: ${userPrefs.location || "N/A"}.`
      : "";
    const systemPrompt = `
You are RozgarAI — an intelligent, empathetic, and professional AI career mentor.

Your mission is to assist users with career growth, job opportunities, and professional guidance while maintaining clarity, precision, and empathy in every response.

Follow these rules with absolute consistency:

1) **Tone & Personality**
   - Always be helpful, professional, confident, and concise.
   - Write naturally, like a real expert mentor — not robotic.
   - Never use slang or filler words. Maintain a polished, conversational tone.

2) **Language Handling**
   - Detected language for this request: \${detectedLanguage}.
   - Supported languages: English, Hindi, Punjabi.
   - If the detected language is supported, respond ONLY in that language.
   - If unsupported, default to **English** automatically.
   - Never mix multiple languages in one response.

3) **Job Search Logic**
   - If the user’s intent is to search for jobs, use the 'find_jobs' tool.
   - Never fabricate or assume job details — rely solely on verified results.
   - Present job results clearly, showing only the most relevant information.

4) **Resource & Learning Links**
   - When users ask for study materials, tutorials, or references, provide **direct, verified, and high-quality URLs** that lead **straight to the exact resource**, not just a homepage.
   - Always verify that each resource is **accurate, active, and safe**.
   - Clearly distinguish between **Free** and **Paid** resources using clear labels such as:
     - 🆓 **Free Resource:** for open-access or no-login content.
     - 💰 **Paid Resource:** for official, premium, or subscription-based options.
   - Always list **Free Resources first**, followed by **Paid** ones.
   - Prefer reputable platforms (e.g., official documentation, Coursera, Udemy, GeeksforGeeks, LeetCode, LinkedIn Learning, NPTEL, or government portals).
   - Ensure that links directly open the intended resource or course page.

5) **Non-Job Queries**
   - For general career or skill-related questions, provide direct, actionable, and motivational advice.
   - Where appropriate, suggest learning paths or structured steps to achieve the goal.

6) **Basic & General Queries**
   - For factual or everyday queries (math, weather, time, definitions, etc.), respond briefly and accurately while maintaining professionalism.
   - Avoid overcomplicating simple requests.

7) **Response Discipline**
   - Stay strictly focused on user intent.
   - Avoid repetition, speculation, and unnecessary elaboration.
   - Always prioritize clarity, accuracy, and user satisfaction.

8) **Fallback Safety**
   - If uncertain about language, topic, or user intent, default gracefully to **English**.
   - Maintain professionalism and reassurance at all times.

9) **Citation & Link Formatting**
   - Format all external links as **clean Markdown hyperlinks**:
     \`[Resource Name](https://example.com)\`
   - Use the **official name or exact course/resource title** as link text.
   - Never expose long raw URLs.
   - Include only verified, safe domains.

10) **Free and Paid Resource Handling**
   - If both free and paid resources exist for a topic:
     - Present **free ones first** (no paywall or login required).
     - Then offer **paid options**, noting any certification, credibility, or added benefits.
   - If only paid resources are available, clearly mention that no free alternatives exist.
   - Never promote affiliate links or unverified commercial sources.

Your goal: Deliver expert guidance, meaningful resources, and trustworthy career support — every single time, with accuracy, empathy, and professionalism.
`;

    const transformedHistory = (Array.isArray(history) ? history : [])
      .filter((m) => m && (m.message || m.text))
      .map((m) => {
        const content = m.message || m.text || "";
        const isAssistant =
          m.type === 1 || m.role === "assistant" || m.isUser === false;
        return { role: isAssistant ? "assistant" : "user", content };
      });

    const messages = [
      { role: "system", content: systemPrompt },
      ...transformedHistory,
      { role: "user", content: message },
    ];

    const openAiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages,
          tools: tools,
          tool_choice: "auto",
        }),
      }
    );

    const openAiData = await openAiResponse.json();
    if (!openAiData || !openAiData.choices || openAiData.choices.length === 0) {
      console.error(
        "OpenAI returned no choices:",
        JSON.stringify(openAiData, null, 2)
      );
      return res
        .status(500)
        .json({ error: "Invalid response from language model." });
    }

    const firstMsg = openAiData.choices[0].message;

    if (firstMsg && firstMsg.tool_calls) {
      messages.push(firstMsg);

      for (const toolCall of firstMsg.tool_calls) {
        const functionName = toolCall.function.name;
        const functionArgsRaw = toolCall.function.arguments || "{}";
        let functionArgs;
        try {
          functionArgs = JSON.parse(functionArgsRaw);
        } catch (e) {
          functionArgs = {};
        }

        console.log("Model requested tool:", functionName, functionArgs);

        let toolResult = null;
        if (functionName === "find_jobs") {
          console.log("Chat is calling find_jobs, setting limit to 5.");
          const chatJobParams = {
            ...functionArgs, // (e.g., query: "java developer")
            jobLimit: 5, // Add our hard-coded limit
          };
          toolResult = await findJobs(chatJobParams);
        } else if (functionName === "get_user_info") {
          toolResult = await fetchUserPreferences(uid);
        } else {
          toolResult = { error: "Unknown function requested." };
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: functionName,
          content: JSON.stringify(toolResult),
        });
      }

      const finalResponse = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },

          body: JSON.stringify({ model: AI_MODEL, messages: messages }),
        }
      );

      const finalData = await finalResponse.json();
      if (!finalData || !finalData.choices || finalData.choices.length === 0) {
        console.error(
          "OpenAI second call failed:",
          JSON.stringify(finalData, null, 2)
        );
        return res
          .status(500)
          .json({ error: "Failed to generate final response." });
      }

      const finalMsg =
        finalData.choices[0].message?.content ||
        finalData.choices[0].message ||
        "";
      return res.json({ reply: finalMsg, detectedLanguage });
    } else {
      const replyContent = firstMsg?.content || "";
      return res.json({ reply: replyContent, detectedLanguage });
    }
  } catch (err) {
    console.error("Error in /chat:", err);
    return res
      .status(500)
      .json({ error: "An error occurred processing the chat." });
  }
});

// ... (your other express setup)

app.get("/skills/analyze", async (req, res) => {
  // ⬇️ 1. Get both uid and the optional jobRole from the query
  const { uid, jobRole: queryJobRole } = req.query;

  if (!uid) return res.status(400).json({ error: "User ID required." });

  try {
    const userPrefs = await fetchUserPreferences(uid);
    if (!userPrefs) {
      return res.status(404).json({ error: "User profile not found." });
    }

    // ⬇️ 2. Determine the job role to use
    //    Priority:
    //    1. The job role from the query (search)
    //    2. The user's saved job role (profile analysis)
    const jobRole = queryJobRole || userPrefs.jobRole;

    // ⬇️ 3. Handle case where no job role is found anywhere
    if (!jobRole) {
      return res
        .status(404)
        .json({ error: "Job role missing. No query role provided and no profile role set." });
    }

    const userSkills = (userPrefs.skills || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // The rest of your function logic remains exactly the same!
    // It will now use the correct `jobRole` (either from query or profile).

    const skillsQuestion = `
List the top 12 most important technical skills for a '${jobRole}'.
Respond ONLY with a comma-separated list.
Each skill must be **only two or three words maximum** (e.g., 'Java', 'React Native', 'Data Analysis').
Do not include explanations, numbers, or symbols.
`;
    const skillsResp = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        // ... (your headers and body)
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [{ role: "user", content: skillsQuestion }],
        }),
      }
    );
    const skillsData = await skillsResp.json();
    const requiredSkillsText = skillsData?.choices?.[0]?.message?.content || "";
    const requiredSkills = requiredSkillsText
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const missingSkills = requiredSkills.filter((s) => !userSkills.includes(s));

    const learningResources = {};
    for (const skill of missingSkills) {
      // ... (your loop to fetch resources)
      const resourceQuestion = `Provide a reputable, public URL for learning '${skill}'. Reply only with the URL.`;
      try {
        const resourceResp = await fetch(
            "https://api.openai.com/v1/chat/completions",
             { /* ... */ }
        );
        const resourceData = await resourceResp.json();
        let url = (resourceData?.choices?.[0]?.message?.content || "").trim();
        // ... (your URL cleaning logic)
        url = url.replace(/["'`\s]/g, "");
        if (url && url.includes(".")) {
          if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://" + url;
          }
          if (url.startsWith("http")) {
            learningResources[skill] = url;
          }
        }
      } catch (err) {
        console.error(`Error fetching resource for ${skill}:`, err.message);
      }
    }

    return res.json({
      jobRole, // This will correctly return the role that was analyzed
      requiredSkills,
      missingSkills,
      learningResources,
    });
  } catch (err) {
    console.error("Error in /skills/analyze:", err);
    return res.status(500).json({ error: "Skill analysis failed." });
  }
});
app.get("/ping", (req, res) => {
  res.status(200).json({ status: "ok", message: "Server is awake" });
});
app.get("/jobs", async (req, res) => {
  const { uid, query, employment_types } = req.query;
  try {
    let queryToUse = query;

    if (!queryToUse && uid) {
      const prefs = await fetchUserPreferences(uid);
      queryToUse = prefs
        ? `${prefs.skills || "jobs"} in ${prefs.location || "India"}`
        : "tech jobs in India";
    } else if (!queryToUse) {
      queryToUse = "jobs in India";
    }

    // ⬇️ MODIFICATION HERE ⬇️
    // Bundle params into an object and set the 50 job limit
    const jobPageParams = {
      query: queryToUse,
      employment_types,
      jobLimit: 50,
    };
    const jobsResult = await findJobs(jobPageParams);
    // ⬆️ END MODIFICATION ⬆️

    return res.json(jobsResult);
  } catch (err) {
    console.error("Error in /jobs:", err);
    return res.status(500).json({ error: "Error fetching jobs." });
  }
});
app.get("/users/:uid/saved-jobs", async (req, res) => {
  const { uid } = req.params;
  try {
    const snap = await db
      .collection("users")
      .doc(uid)
      .collection("saved_jobs")
      .get();
    const saved = snap.docs.map((d) => d.data());
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
    await db
      .collection("users")
      .doc(uid)
      .collection("saved_jobs")
      .doc(jobId)
      .set(jobData);
    return res.status(201).json({ message: "Job saved." });
  } catch (err) {
    console.error("Error saving job:", err);
    return res.status(500).json({ error: "Could not save job." });
  }
});

app.delete("/users/:uid/saved-jobs/:jobId", async (req, res) => {
  const { uid, jobId } = req.params;
  try {
    await db
      .collection("users")
      .doc(uid)
      .collection("saved_jobs")
      .doc(jobId)
      .delete();
    return res.json({ message: "Job unsaved." });
  } catch (err) {
    console.error("Error deleting saved job:", err);
    return res.status(500).json({ error: "Could not unsave job." });
  }
});

app.get("/counseling/custom-guide", async (req, res) => {
  const { fromCountry, toCountry, degree, topics } = req.query;
  console.log(
    `[Custom Guide] Request: ${fromCountry} to ${toCountry} for ${degree}`
  );
  console.log(`[Custom Guide] Topics: ${topics}`);

  if (!fromCountry || !toCountry || !degree || !topics) {
    return res.status(400).json({
      error:
        "Missing required fields. Please provide fromCountry, toCountry, degree, and topics.",
    });
  }

  const requestedTopics = topics.split(",");

  let contentInstructions =
    'The "content" field MUST be a detailed Markdown guide. ONLY include the following sections:\n';
  let universityInstructions =
    'The "universities" field MUST be an empty array [].';

  if (requestedTopics.includes("Admission Requirements")) {
    contentInstructions +=
      "1.  **Admission Requirements:** General requirements for a student from ${fromCountry} (e.g., typical GPA, required tests like GRE/GMAT, language tests like IELTS/TOEFL, required documents like SOP/LORs).\n";
  }
  if (requestedTopics.includes("Estimated Annual Cost")) {
    contentInstructions +=
      "2.  **Estimated Annual Cost:** Provide a realistic estimated range for Tuition and Living Expenses. *You MUST specify the currency* (e.g., USD, CAD, GBP).\n";
  }
  if (requestedTopics.includes("Visa Process")) {
    contentInstructions +=
      "3.  **Visa Process:** Provide the *official name* of the student visa (e.g., F-1, Study Permit) and 2-3 key, actionable steps for a student from ${fromCountry} (e.g., 'Receive I-20/LOA', 'Pay SEVIS Fee', 'Provide Proof of Funds').\n";
  }
  if (requestedTopics.includes("Scholarship Opportunities")) {
    contentInstructions +=
      "4.  **Scholarship Opportunities:** List 2-4 major, non-generic scholarships available for students from ${fromCountry}. *You MUST include a direct, valid, clickable Markdown link* to the official scholarship page for each one.\n";
  }
  if (requestedTopics.includes("Post-Study Work Options")) {
    contentInstructions +=
      "5.  **Post-Study Work Options:** A 2-4 sentence summary of post-graduation work opportunities. Include the *official permit name* (e.g., OPT, PGWP) and its typical duration.\n";
  }
  if (requestedTopics.includes("Top Universities")) {
    universityInstructions =
      'The "universities" field MUST be a JSON array of 3-5 objects. Each object MUST have "name" (official university name), "location" (City, State/Province), and "link" (the *direct international admissions/application URL*, NOT the homepage).';
    contentInstructions +=
      "6.  **Top Universities:** Briefly mention the universities you are providing in the 'universities' JSON array.\n";
  }

  const contentPrompt = `
You are an expert international study consultant. A student from "${fromCountry}" wants to pursue a "${degree}" degree in "${toCountry}".
Your response MUST be a single, valid JSON object with TWO top-level keys: "content" (a Markdown string) and "universities" (a JSON array).
---
### CONTENT FIELD INSTRUCTIONS
${contentInstructions}
---
### UNIVERSITIES FIELD INSTRUCTIONS
${universityInstructions}
---
Respond ONLY with the complete JSON object.
`;

  try {
    const openAiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: contentPrompt }],
          temperature: 0.3,
        }),
      }
    );

    const data = await openAiResponse.json();
    if (!openAiResponse.ok || !data?.choices?.[0]?.message?.content) {
      throw new Error("Failed to get guide from AI model.");
    }

    let rawContent = data.choices[0].message.content.trim();

    try {
      const jsonMatch = rawContent.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        rawContent = jsonMatch[1].trim();
      }

      const finalData = JSON.parse(rawContent);

      res.json({
        content: finalData.content || "",
        universities: finalData.universities || [],
      });
    } catch (parseError) {
      console.error(
        "[Custom Guide] Failed to parse AI JSON response:",
        parseError
      );
      console.error("[Custom Guide] Attempted to parse:", rawContent);
      throw new Error("AI model returned an unparsable JSON structure.");
    }
  } catch (error) {
    console.error("Error in /counseling/custom-guide:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to generate custom guide." });
  }
});

app.get("/counseling/get-specializations", async (req, res) => {
  const { degree } = req.query;
  if (!degree) {
    return res.status(400).json({ error: "Degree is required." });
  }
  console.log(`[Get Specializations] Request received for: ${degree}`);

  const prompt = `
You are an academic data expert. Your task is to list the top 30–40 most accurate and commonly recognized specializations, majors, or research areas for the degree: "${degree}".

Guidelines:
1. If "${degree}" is a broad or general degree (e.g., "Bachelor of Arts", "Bachelor of Science", "Master of Engineering"), return common majors or concentrations typically offered under that degree type.
2. If "${degree}" is a specific or professional degree (e.g., "MBA", "PhD in Physics", "Doctor of Medicine", "Master of Computer Science"), list precise and realistic specializations, subfields, or research areas directly relevant to it.
3. Use globally recognized academic or industry terminology.
4. Avoid duplicate or vague entries. Focus on accuracy and diversity across disciplines.
5. Output ONLY a valid JSON array of strings. Do not include any explanation, commentary, or formatting outside the JSON.

Example:
["Computer Science", "Data Analytics", "Electrical Engineering", "Mechanical Engineering", "Artificial Intelligence"]
`;

  try {
    const openAiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
        }),
      }
    );

    const data = await openAiResponse.json();
    const content = data.choices[0].message.content;

    const specializationsList = JSON.parse(content);

    res.json({ specializations: specializationsList });
  } catch (err) {
    console.error(`Error fetching specializations for ${degree}:`, err);
  }
});

app.get("/counseling/get-degrees", async (req, res) => {
  console.log("[Get Degrees] Request received.");

  const prompt = `
You are a global higher-education data expert specializing in international academic programs.

Your task:
List **exactly 120** of the most **commonly recognized academic and professional degrees worldwide**, across undergraduate, postgraduate, and doctoral levels.

Requirements:
1. Include both **general degree types** (e.g., "Bachelor of Science") and **professional/specialized degrees** (e.g., "Doctor of Medicine", "Master of Public Health").
2. Cover a wide range of disciplines — STEM, business, humanities, law, medicine, arts, social sciences, and emerging fields (e.g., data science, AI, cybersecurity).
3. Use **complete official degree names** (not abbreviations like B.Sc. or Ph.D.).
4. Sort the array **alphabetically**.
5. Remove duplicates or near-duplicates.
6. Focus on degrees that are **globally offered or internationally recognized** by universities.
7. Respond **ONLY** with a **valid JSON array of strings**, containing exactly 120 items.
8. Do **not** include explanations, numbers, comments, or formatting outside the JSON.

Example (structure only):
["Bachelor of Arts", "Bachelor of Science", "Master of Business Administration", "Doctor of Philosophy"]
`;

  try {
    const openAiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        }),
      }
    );

    const data = await openAiResponse.json();
    const content = data.choices[0].message.content;

    const degreesList = JSON.parse(content);

    res.json({ degrees: degreesList });
  } catch (err) {
    console.error("Error fetching degrees from AI:", err);
    res.status(500).json({ error: "Failed to fetch degree list." });
  }
});
app.get("/interview-prep/get-stats", async (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    return res.status(400).json({ error: "User ID is required." });
  }
  try {
    const stats = await getUserStats(uid);
    res.json(stats);
  } catch (err) {
    console.error("Error in /get-stats:", err);
    res.status(500).json({ error: "Failed to fetch user stats." });
  }
});

app.post("/interview-prep/increment-stat", async (req, res) => {
  const { uid, statName } = req.body;

  if (!uid || !statName) {
    return res.status(400).json({ error: "uid and statName are required." });
  }

  const allowedStats = [
    "hrAnswersCompleted",
    "starStoriesSaved",
    "techQuestionsPracticed",
    "mockInterviewsRecorded",
    "companyNotesCreated",
  ];

  if (!allowedStats.includes(statName)) {
    return res.status(400).json({ error: "Invalid statName." });
  }

  try {
    const statsRef = db.collection("user_stats").doc(uid);
    await statsRef.update({
      [statName]: admin.firestore.FieldValue.increment(1),
    });

    res.status(200).json({ message: `Stat ${statName} incremented.` });
  } catch (err) {
    if (err.code === 5) {
      try {
        const defaultStats = {
          hrAnswersCompleted: 0,
          starStoriesSaved: 0,
          techQuestionsPracticed: 0,
          mockInterviewsRecorded: 0,
          companyNotesCreated: 0,
          [statName]: 1,
        };
        await db.collection("user_stats").doc(uid).set(defaultStats);
        return res
          .status(200)
          .json({ message: `Stat ${statName} incremented.` });
      } catch (createErr) {
        console.error("Error creating stats doc:", createErr);
        return res.status(500).json({ error: "Failed to create stats." });
      }
    }
    console.error("Error in /increment-stat:", err);
    res.status(500).json({ error: "Failed to increment stat." });
  }
});

async function simpleOpenAICall(prompt, model = AI_MODEL, temperature = 0.5) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "user", content: prompt }],
        temperature: temperature,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data?.choices?.[0]?.message?.content) {
      console.error("OpenAI simple call error:", JSON.stringify(data, null, 2));
      throw new Error("Failed to get response from AI model.");
    }
    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error in simpleOpenAICall:", error);
    throw error;
  }
}
app.get("/interview-prep/questions", async (req, res) => {
  const { category, jobRole = "general", count = 10 } = req.query;

  if (!category) {
    return res
      .status(400)
      .json({ error: "Category is required (e.g., HR, Technical)." });
  }

  const prompt = `
You are a world-class interview coach and hiring strategist with deep expertise in global recruitment practices.

Your task:
Generate **${count}** highly relevant **${category}** interview questions tailored specifically for a **${jobRole}** candidate.

### Requirements:
1. The questions must be **authentic, practical, and insight-driven**, matching real-world interview standards for ${jobRole}.
2. Maintain a **balanced mix** of difficulty levels — from foundational to challenging — suitable for assessing knowledge, problem-solving, and communication.
3. If the category implies a question style, follow it strictly:
   - "Technical" → Deep domain questions requiring reasoning or applied knowledge.
   - "HR" or "Behavioral" → Situational or personality-based questions (e.g., STAR format).
   - "Managerial" → Leadership, decision-making, and scenario-based judgment questions.
   - "Aptitude" → Logical reasoning or quantitative thinking questions.
4. Avoid duplicates, filler questions, or generic “Tell me about yourself”-type prompts.
5. Questions must be **clear, concise, and free of bias** — phrased naturally, as a professional interviewer would.
6. Return **ONLY** a valid JSON array of strings — no numbering, formatting, or explanations.
7. Ensure the array has **exactly ${count} questions**.
8. Do **not** include any text, comments, or examples outside the JSON.

### Example Format:
["What is polymorphism in object-oriented programming?", "Describe a time you resolved a conflict within your team."]
`;

  try {
    const content = await simpleOpenAICall(prompt, AI_MODEL, 0.7);
    const questionsList = JSON.parse(content); // The prompt forces JSON
    res.json({ questions: questionsList });
  } catch (err) {
    console.error("Error in /interview-prep/questions:", err);
    res.status(500).json({ error: "Failed to generate questions." });
  }
});
app.get("/interview-prep/daily-tip", async (req, res) => {
  const prompt = `
You are a world-class career coach and interview strategist with deep experience mentoring candidates across global industries.

Your task:
Provide **one** powerful, practical, and immediately actionable **interview tip** that helps candidates improve performance, confidence, or impact during interviews.

### Requirements:
1. The tip must be **specific, realistic, and high-value** — not generic advice like “Be confident” or “Research the company.”
2. Keep it **concise (maximum 2 sentences)** and **professionally worded**.
3. Focus on *actionable behavior or mindset shifts* proven to make a measurable difference in interviews.
4. Tailor it to apply broadly across most job roles and industries.
5. Respond **ONLY** with the tip text — no titles, labels, introductions, or formatting.

Example Output:
“Before answering, pause for two seconds to collect your thoughts — it signals confidence and clarity to interviewers.”
`;

  try {
    const tip = await simpleOpenAICall(prompt, AI_MODEL, 0.8);
    res.json({ tip: tip });
  } catch (err) {
    console.error("Error in /interview-prep/daily-tip:", err);
    res.status(500).json({ error: "Failed to get daily tip." });
  }
});
app.post("/interview-prep/generate-email", async (req, res) => {
  const { jobTitle, companyName, tone = "formal" } = req.body;
  if (!jobTitle || !companyName) {
    return res
      .status(400)
      .json({ error: "jobTitle and companyName are required." });
  }

  const prompt = `
You are an award-winning professional career writer and communication strategist.

Your task:
Write a **concise, polished thank-you email template** for a **${jobTitle}** position at **${companyName}**.

### Requirements:
1. The tone must be **${tone}**, consistent, and natural (e.g., professional, warm, appreciative, or formal depending on input).
2. The email should feel **genuine and personalized**, not robotic — appropriate for sending to a real interviewer.
3. Include these placeholders:
   - [Interviewer Name]
   - [Specific Point Discussed]
   - [Your Name]
   - [Job Title]
   - [Company Name]
4. Structure:
   - **Subject line** (short, relevant, professional)
   - **Body** (3–5 sentences max)
   - **Professional closing**
5. The email must:
   - Express appreciation for the opportunity and interviewer’s time.
   - Reference [Specific Point Discussed] naturally.
   - Reaffirm interest in the role and cultural fit.
   - End with a courteous closing line.
6. The final response must be **ONLY the full email text** (including subject line) — no explanations, commentary, or Markdown formatting.

### Example Structure:
Subject: Thank You – Interview for [Job Title]

Dear [Interviewer Name],
Thank you for taking the time to meet with me regarding the [Job Title] role at [Company Name]. I especially appreciated our discussion about [Specific Point Discussed], which strengthened my enthusiasm for contributing to your team. I look forward to the possibility of joining [Company Name] and adding value to your goals.  
Warm regards,  
[Your Name]
`;

  try {
    const template = await simpleOpenAICall(prompt, AI_MODEL, 0.5);
    res.json({ template: template });
  } catch (err) {
    console.error("Error in /interview-prep/generate-email:", err);
    res.status(500).json({ error: "Failed to generate email template." });
  }
});

app.delete("/users/:uid/prep-data", async (req, res) => {
  const { uid } = req.params;
  const { dataType, dataId } = req.body;

  if (!uid || !dataType || !dataId) {
    return res
      .status(400)
      .json({ error: "uid, dataType, and dataId are required." });
  }

  try {
    await db
      .collection("users")
      .doc(uid)
      .collection("interview_prep")
      .doc(dataType)
      .collection("items")
      .doc(dataId)
      .delete();

    res.status(200).json({ message: `${dataType} item deleted.` });
  } catch (err) {
    console.error("Error deleting prep-data:", err);
    res.status(500).json({ error: `Could not delete ${dataType} item.` });
  }
});
app.get("/interview-prep/tips-list", async (req, res) => {
  const { count = 20 } = req.query;

  const prompt = `
You are a world-class career coach and interview strategist with years of experience training candidates for global companies across industries.

Your task:
Generate **${count}** unique, high-impact, and **actionable interview tips** that help candidates perform better in job interviews.

### Requirements:
1. Each tip must be **concise (1–2 sentences)** and **practically useful** — something a real candidate can apply immediately.
2. Tips must be **unique, realistic, and non-generic** — avoid vague advice like “Be confident” or “Dress professionally.”
3. Focus on a balance of **behavioral**, **technical**, and **communication-related** insights that apply broadly across most roles.
4. Each tip should teach something **specific** — for example:
   - How to structure an answer effectively  
   - How to show confidence through body language  
   - How to ask insightful questions  
   - How to handle difficult questions or rejections  
5. Language must be **clear, motivational, and professional** — no filler, clichés, or redundancy.
6. Respond **ONLY** with a valid **JSON array of strings**, containing exactly **${count}** items.
7. Do **not** include numbering, markdown, explanations, or extra text — only the clean JSON array.

### Example Output:
[
  "Pause briefly before answering to show composure and give yourself time to think.",
  "When discussing weaknesses, focus on how you've actively worked to improve them.",
  "Use specific examples to demonstrate your skills rather than broad statements."
]
`;

  try {
    let tipsJson = await simpleOpenAICall(prompt, AI_MODEL, 0.8);

    const jsonMatch = tipsJson.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      tipsJson = jsonMatch[1].trim();
    }

    const tipsList = JSON.parse(tipsJson);
    res.json({ tips: tipsList });
  } catch (err) {
    console.error("Error in /interview-prep/tips-list:", err);
    console.error("Failed to parse this JSON:", tipsJson);
    res.status(500).json({ error: "Failed to generate tips list." });
  }
});
app.post("/interview-prep/evaluate-star", async (req, res) => {
  const { situation, task, action, result } = req.body;
  if (!situation || !task || !action || !result) {
    return res
      .status(400)
      .json({ error: "All four STAR fields are required." });
  }

  const prompt = `
You are a highly experienced HR manager and certified behavioral interviewer with deep expertise in STAR (Situation, Task, Action, Result) evaluation.

Your task:
Assess the following candidate’s STAR response objectively and professionally.

### Candidate Response
- **Situation:** ${situation}
- **Task:** ${task}
- **Action:** ${action}
- **Result:** ${result}

### Evaluation Guidelines
1. Analyze how well the response demonstrates **clarity, relevance, impact, and reflection**.
2. Consider whether the candidate effectively:
   - Described a **specific, relevant situation** (not hypothetical or vague)
   - Clarified their **individual contribution** (not just the team’s)
   - Showed **initiative and problem-solving ability**
   - Quantified or clearly communicated **results and impact**
3. Avoid generic comments. Provide nuanced, professional-level feedback reflecting real HR judgment.
4. Maintain a constructive, supportive tone focused on **growth and improvement**.
5. Output **only** a valid JSON object using this exact schema:
   {
     "strength": "Detailed yet concise analysis of what worked well (3–6 sentences).",
     "weakness": "Detailed yet concise critique of what was weak, unclear, or missing (3–6 sentences).",
     "suggestion": "Actionable, specific advice to improve future STAR answers (3–6 sentences)."
   }

Do not include any commentary, markdown, or text outside the JSON object.
`;

  try {
    let feedbackJson = await simpleOpenAICall(prompt, "gpt-4o", 0.4);

    const jsonMatch = feedbackJson.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      feedbackJson = jsonMatch[1].trim();
    }

    const feedback = JSON.parse(feedbackJson);
    res.json(feedback);
  } catch (err) {
    console.error("Error in /interview-prep/evaluate-star:", err);
    console.error("Failed to parse this JSON:", feedbackJson);
    res.status(500).json({ error: "Failed to evaluate STAR answer." });
  }
});

app.post("/interview-prep/evaluate-answer", async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) {
    return res.status(400).json({ error: "Question and answer are required." });
  }

  const prompt = `
You are a professional interview coach with expertise in communication, behavioral psychology, and candidate assessment.

Your task:
Evaluate the candidate’s response to the following interview question.

### Input
- **Question:** "${question}"
- **Answer:** "${answer}"

### Feedback Requirements
1. Provide **concise, balanced, and actionable feedback** (total 3–4 sentences).
2. Start with a **genuine positive observation** highlighting what the candidate did well (e.g., tone, relevance, structure, or confidence).
3. Follow with a **constructive improvement point**, explaining briefly how the answer could be more effective (e.g., clearer examples, stronger impact, better structure, or measurable results).
4. Feedback must sound **human, specific, and professional**, not robotic or generic.
5. Focus on **clarity, logical flow, and overall impact** — avoid rephrasing the answer itself.
6. Respond **ONLY** with the feedback text (no labels, bullet points, or formatting).

Example Output:
"Your answer clearly showed enthusiasm and strong communication skills. However, you could improve by structuring your response using the STAR method to make your achievements more measurable and memorable."
`;

  try {
    const feedback = await simpleOpenAICall(prompt, AI_MODEL, 0.5);
    res.json({ feedback: feedback });
  } catch (err) {
    console.error("Error in /interview-prep/evaluate-answer:", err);
    res.status(500).json({ error: "Failed to evaluate answer." });
  }
});
app.post("/users/:uid/prep-data", async (req, res) => {
  const { uid } = req.params;
  const { dataType, dataId, data } = req.body;

  if (!dataType || !dataId || !data) {
    return res
      .status(400)
      .json({ error: "dataType, dataId, and data are required." });
  }

  try {
    await db
      .collection("users")
      .doc(uid)
      .collection("interview_prep")
      .doc(dataType)
      .collection("items")
      .doc(dataId)
      .set(data, { merge: true });

    res.status(201).json({ message: `${dataType} saved.` });
  } catch (err) {
    console.error("Error saving prep-data:", err);
    res.status(500).json({ error: `Could not save ${dataType}.` });
  }
});
app.get("/users/:uid/prep-data", async (req, res) => {
  const { uid } = req.params;
  const { dataType } = req.query;

  if (!dataType) {
    return res.status(400).json({ error: "dataType is required." });
  }

  try {
    const snap = await db
      .collection("users")
      .doc(uid)
      .collection("interview_prep")
      .doc(dataType)
      .collection("items")
      .get();

    const allData = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(allData);
  } catch (err) {
    console.error("Error fetching prep-data:", err);
    res.status(500).json({ error: `Could not fetch ${dataType}.` });
  }
});
app.get("/interview-prep/technical-questions", async (req, res) => {
  const { uid, count = 15 } = req.query;

  if (!uid) {
    return res.status(400).json({ error: "User ID (uid) is required." });
  }

  let jobRole = "Software Engineer";
  let skills = "Data Structures and Algorithms";
  try {
    const userPrefs = await fetchUserPreferences(uid);
    if (userPrefs) {
      jobRole = userPrefs.jobRole || jobRole;
      skills = userPrefs.skills || skills;
    }
  } catch (err) {
    console.warn(
      "Could not fetch user profile for tech questions, using defaults."
    );
  }
  const prompt = `
You are a senior technical interviewer and certified career coach with extensive experience preparing candidates for top-tier technical roles.

Your task:
Generate **${count}** realistic and relevant **technical interview questions** for a candidate applying for a **${jobRole}** role, who lists these skills: **${skills}**.

### Question Requirements:
1. Each question must directly test or relate to **core technical competencies** in the candidate’s listed skills.
2. Include a balanced variety of topics:
   - Conceptual and theory-based questions
   - Coding or algorithmic problems
   - System design or practical scenario questions (if applicable)
3. The questions should be **clear, industry-standard, and aligned with actual interview expectations** for the role.
4. Avoid trivial or duplicate questions.

### URL Requirements:
1. For each question, provide **exactly one** verified, high-quality URL where the candidate can **learn or practice** that specific topic.
2. Acceptable sources: **LeetCode**, **HackerRank**, **GeeksforGeeks**, **freeCodeCamp**, **official documentation (e.g., Java, Python, React)**, or **respected tech blogs**.
3. The URL must be:
   - **Direct and specific** (no homepages, category pages, or search result links)
   - **Relevant** to the question content (not a random tutorial)
   - **Fully-qualified**, starting with "https://"
4. Each question and URL must form a **logical pair** — i.e., the resource must genuinely teach or help solve that exact question.

### Output Format:
Respond **only** with a valid JSON array of exactly **${count} objects**, using the structure:
[
  {
    "question": "Question text here",
    "url": "https://..."
  },
  ...
]

### Output Rules:
- Do NOT include any explanations, markdown, comments, or extra text.
- Ensure all URLs are real, relevant, and fully functional.
- Ensure all questions are unique and directly related to ${jobRole} and ${skills}.
`;

  try {
    let questionsJson = await simpleOpenAICall(prompt, "gpt-4o", 0.6);

    const jsonMatch = questionsJson.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      questionsJson = jsonMatch[1].trim();
    }

    const questionsList = JSON.parse(questionsJson);
    res.json(questionsList);
  } catch (err) {
    console.error("Error in /interview-prep/technical-questions:", err);
    console.error("Failed to parse this JSON:", questionsJson);
    res.status(500).json({ error: "Failed to generate technical questions." });
  }
});

// =================================================================
// 5. START SERVER
// =================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
