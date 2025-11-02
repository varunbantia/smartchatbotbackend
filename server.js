import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import path from 'path';
import speech from "@google-cloud/speech";
import admin from "firebase-admin";
import { URL } from "url";
import { franc } from "franc";
import langs from "langs";
import { DocumentProcessorServiceClient } from '@google-cloud/documentai';

dotenv.config();

// =================================================================
// 1. CONFIGURATION & INITIALIZATION
// =================================================================

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Ensure the uploads directory exists
        const uploadDir = 'uploads/';
        if (!fs.existsSync(uploadDir)){
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir); // Save files in the 'uploads/' folder
    },
    filename: function (req, file, cb) {
        // Use a unique name but keep the original extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = path.extname(file.originalname); // Get extension from ORIGINAL name
        cb(null, file.fieldname + '-' + uniqueSuffix + extension); // e.g., resumeFile-123456789.pdf
    }
});
const upload = multer({
    storage: storage, // Use the configured disk storage
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
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
const docAIprojectId = googleServiceAccount?.project_id; // Get project ID from credentials
const docAIlocation = process.env.DOC_AI_LOCATION || 'us'; // e.g., 'us' or 'eu' - MUST MATCH YOUR PROCESSOR REGION
const docAIprocessorId = process.env.DOC_AI_PROCESSOR_ID; // The ID of your *OCR* processor

try {
    if (!googleServiceAccount) throw new Error("Missing Google credentials JSON for Document AI");
    if (!docAIprojectId || !docAIprocessorId) throw new Error ("Missing project_id in credentials or DOC_AI_PROCESSOR_ID in env vars");

    docAIClient = new DocumentProcessorServiceClient({
        credentials: {
            client_email: googleServiceAccount.client_email,
            private_key: googleServiceAccount.private_key,
        },
        projectId: docAIprojectId,
        // Optional: Explicitly set endpoint if needed, based on your processor's region
        // apiEndpoint: `${docAIlocation}-documentai.googleapis.com`
    });
    console.log("✅ Google Document AI client initialized successfully.");
} catch (err) {
    console.error("🔥 Google Document AI initialization failed:", err);
}
const db = admin.firestore();

// =================================================================
// 2. HELPERS
// =================================================================
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function extractResumeText(filePath, fileMimeType) {
    if (!docAIClient) {
        throw new Error("Document AI client is not initialized.");
    }
    if (!docAIprojectId || !docAIlocation || !docAIprocessorId) {
        throw new Error("Document AI configuration is missing.");
    }
    console.log(`Sending file to Document AI OCR: ${filePath}, MIME: ${fileMimeType}`);

    try {
        const content = fs.readFileSync(filePath).toString('base64');
        const name = `projects/${docAIprojectId}/locations/${docAIlocation}/processors/${docAIprocessorId}`; // Use OCR Processor ID
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

        console.log(`Extracted ${document.text.length} characters via Document AI OCR.`);
        return document.text; // Return the full extracted text

    } catch (error) {
        console.error(`Error calling Google Document AI OCR:`, error);
        const errorMessage = error.details || error.message || "Unknown Document AI OCR error";
        throw new Error(`Failed to process document with OCR: ${errorMessage}`);
    }
}
async function getUserStats(uid) {
    if (!uid) return null;
    const statsRef = db.collection("user_stats").doc(uid);
    const doc = await statsRef.get();
    
    if (!doc.exists) {
        // Create default stats
        const defaultStats = {
            hrAnswersCompleted: 0,
            starStoriesSaved: 0,
            techQuestionsPracticed: 0,
            mockInterviewsRecorded: 0,
            companyNotesCreated: 0
        };
        await statsRef.set(defaultStats);
        return defaultStats;
    }
    return doc.data();
}
// --- NEW HELPER: Get Resume Feedback from AI ---
async function getResumeFeedback(resumeText) {
    if (!resumeText || resumeText.trim().length < 50) { // Basic check for meaningful text
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
List 3–5 strengths observed in the resume. Focus on clarity, structure, tone, and presentation.
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

    // --- END UPDATED PROMPT ---

    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: AI_MODEL, // Or a more advanced model if needed for analysis
                messages: [{ role: "user", content: analysisPrompt }],
                temperature: 0.5, // Slightly lower temperature for more focused feedback
            }),
        });

        const data = await response.json();

        if (!response.ok || !data?.choices?.[0]?.message?.content) {
            console.error("OpenAI error during feedback generation:", JSON.stringify(data, null, 2));
            throw new Error("Failed to get analysis from AI model.");
        }
        console.log("AI analysis successful.");
        return data.choices[0].message.content.trim();

    } catch (error) {
        console.error("Error calling OpenAI for resume feedback:", error);
        throw new Error("Could not get feedback from AI."); // Rethrow a user-friendly error
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

// --- NEW HELPER FUNCTIONS ---

/**
 * Formats salary data from JSearch job object
 */
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

/**
 * Gets job type (Remote, Full-time, etc.) from JSearch job object
 */
function getJobType(job) {
  if (!job) return "N/A";
  if (job.job_is_remote) return "Remote"; // Capitalize first letter (e.g., FULLTIME -> Full-time)
  const empType = job.job_employment_type;
  if (empType) {
    return empType.charAt(0) + empType.slice(1).toLowerCase();
  }
  return "On-site"; // Default if not remote and no type specified
}

/**
 * Cleans a job description by:
 * 1. Fixing fragmented lines (merging single newlines).
 * 2. Removing duplicate paragraphs (that were separated by double newlines).
 */
function cleanJobDescription(description) {
    if (!description || typeof description !== 'string') {
        return "No description available.";
    }

    // This Set will store our final, clean paragraphs.
    const uniqueParagraphs = new Set();

    // 1. Split the whole text by *double* newlines, which usually mark real paragraphs.
    const paragraphs = description.split(/\n\s*\n/); // Splits on \n\n or \n \n

    for (const para of paragraphs) {
        
        // 2. Fix fragmentation:
        //    Replace all *single* newlines *within* the paragraph with a space.
        //    This merges "developing" and "and maintaining high" into one line.
        const reFlowedParagraph = para.replace(/\n/g, ' ').trim();

        // 3. Only add the paragraph if it has actual content
        if (reFlowedParagraph) {
            
            // 4. Fix duplication:
            //    Adding to a Set automatically removes duplicate paragraphs.
            uniqueParagraphs.add(reFlowedParagraph);
        }
    }

    // 5. Join the clean, unique paragraphs back together with proper spacing.
    return Array.from(uniqueParagraphs).join('\n\n');
}

/**
 * Formats experience data from JSearch job object (with text fallback)
 */
function getExperience(job) {
    if (!job) return "Not Disclosed";

    // === STEP 1: Try to use the "clean" structured data first ===
    if (job.job_required_experience) {
        const exp = job.job_required_experience;
        if (exp.no_experience_required) return "Entry Level";

        const months = exp.required_experience_in_months;
        if (months) {
            if (months < 12) return `${months} months`;
            const years = (months / 12).toFixed(1).replace('.0', '');
            return `${years}+ years`;
        }
    }

    // === STEP 2: FALLBACK - Scan the raw job description text ===
    // If the structured data was null, we search the description.
    if (job.job_description) {
        const description = job.job_description.toLowerCase();
        
        // Look for patterns like "5-7 years", "5+ years", "5 years"
        // This regex looks for: (number)-(number) years, (number)+ years, or (number) years
        const regex = /(\d[\d.,-]*\+?)\s*(to|-)?\s*(\d[\d.,-]*\+?)?\s*(year|yr|month)s?/i;
        const match = description.match(regex);

        if (match) {
            // We found a match!
            // match[1] is the first number (e.g., "5")
            // match[2] is the dash (e.g., "-")
            // match[3] is the second number (e.g., "7")
            // match[4] is "year" or "month"
            
            if (match[3]) {
                // It's a range like "5-7 years"
                return `${match[1]}-${match[3]} ${match[4]}s`;
            } else {
                // It's a single value like "5+ years" or "5 years"
                return `${match[1]} ${match[4]}s`;
            }
        }

        // Check for "entry level"
        if (description.includes("entry level") || description.includes("no experience")) {
            return "Entry Level";
        }
    }

    // === STEP 3: If we still find nothing, then it's undisclosed ===
    return "Not Disclosed";
}

/**
 * UPDATED findJobs Function
 */
// REPLACE your old findJobs function with this one

const findJobs = async (params) => {
  // 🚀 NEW LOG 1: Check if the key is even loaded
  console.log("[findJobs] Checking API Key...");
  if (!process.env.JSEARCH_API_KEY) {
    console.error("[findJobs] FATAL: JSEARCH_API_KEY is NOT loaded from .env file.");
    return [];
  }
  console.log("[findJobs] API Key is loaded.");

  try {
    const { query, employment_types } = params || {};
    if (!query || query.trim() === "") return [];

    const url = new URL("https://jsearch.p.rapidapi.com/search");
    url.searchParams.append("query", query);
    
    // 🚀 NEW LOG 2: Show the exact URL we are about to fetch
    console.log("[findJobs] Fetching URL:", url.toString());

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": process.env.JSEARCH_API_KEY,
        "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
      },
      timeout: 10000, // 🚀 NEW: Add a 10-second timeout
    });

    // 🚀 NEW LOG 3: Show the status of the response
    console.log("[findJobs] Response status:", response.status, response.statusText);

    const result = await response.json();

    if (!result?.data || result.data.length === 0) {
      // 🚀 NEW LOG 4: This is the "No Data" scenario
      console.log("[findJobs] API call succeeded but returned no data (result.data is empty).");
      return [];
    }

    const jobs = await Promise.all(
      result.data.slice(0, 7).map(async (job) => {
        // ... (your existing mapping logic) ...
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

    // 🚀 NEW LOG 5: If we get here, it worked.
    console.log(`[findJobs] Success. Found ${jobs.length} jobs.`);
    return jobs;

  } catch (err) {
    // 🚀 NEW LOG 6: This will catch the timeout or any other failure
    console.error("[findJobs] CRITICAL ERROR during fetch:", err.name, err.message);
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
  const fileMimeType = req.file.mimetype; // Get MIME type from multer
  const originalFilename = req.file.originalname;
  console.log(`Received resume file for analysis: ${filePath} (Original: ${originalFilename}, MIME: ${fileMimeType})`);

  // Basic MIME type check (Document AI supports more types)
  const allowedMimeTypes = [
      'application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/gif',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      // Add others supported by Document AI OCR if needed
    ];
  if (!allowedMimeTypes.includes(fileMimeType)) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath); // Clean up
      console.warn(`Unsupported MIME type for Document AI OCR: ${fileMimeType}`);
      return res.status(400).json({ error: `Unsupported file type: ${fileMimeType}.` });
  }

  try {
    // 1. Extract Text (Uses Document AI OCR helper)
    const resumeText = await extractResumeText(filePath, fileMimeType);

    // 2. Get Feedback from AI (Remains the same)
    const analysisResult = await getResumeFeedback(resumeText);

    // 3. Send successful response
    res.json({ analysisResult: analysisResult });

  } catch (error) {
    console.error("Error during resume analysis:", error);
    res.status(500).json({ error: error.message || "Failed to analyze resume." });
  } finally {
    // Clean up the uploaded file ALWAYS
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

// === THIS IS THE CORRECTED /chat ENDPOINT ===
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
    const systemPrompt = `You are RozgarAI, an expert and empathetic AI career mentor.
Follow these rules:
1) Tone: helpful, professional, concise.
2) When responding, use EXACTLY the user's detected language and ONLY that language.
Detected language for this request: ${detectedLanguage}.
Supported languages: English, Hindi, Punjabi.
3) If the user's intent is a job search, use the 'find_jobs' tool. Do not hallucinate job details.
4) For non-job queries give short, actionable guidance.
5) Never mix languages within a single response. Reply only in ${detectedLanguage}.`;

    const transformedHistory = (Array.isArray(history) ? history : [])
      .filter((m) => m && (m.message || m.text))
      .map((m) => {
        const content = m.message || m.text || "";
        const isAssistant =
          m.type === 1 || m.role === "assistant" || m.isUser === false;
        return { role: isAssistant ? "assistant" : "user", content };
      });
    
    // The message history starts with the system prompt and history
    const messages = [
      { role: "system", content: systemPrompt },
      ...transformedHistory,
      { role: "user", content: message },
    ];

    // === FIRST API CALL (MODIFIED) ===
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
          tools: tools, // <-- 🚀 FIX 1: Use 'tools' (not 'functions')
          tool_choice: "auto", // <-- 🚀 FIX 2: Use 'tool_choice' (not 'function_call')
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

    // === RESPONSE HANDLING (MODIFIED) ===
    // 🚀 FIX 3: Check for 'tool_calls' (an array) instead of 'function_call' (an object)
    if (firstMsg && firstMsg.tool_calls) {
      
      // Add the assistant's reply (which contains the tool_calls) to the message history
      messages.push(firstMsg);

      // Loop over each tool call the model wants to make (it can be multiple)
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
          toolResult = await findJobs(functionArgs);
        } else if (functionName === "get_user_info") {
          toolResult = await fetchUserPreferences(uid);
        } else {
          toolResult = { error: "Unknown function requested." };
        }

        // 🚀 FIX 4: Add the tool result message.
        // It MUST include the 'tool_call_id' to link it to the assistant's request.
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id, // This is the critical ID
          name: functionName,
          content: JSON.stringify(toolResult),
        });
      }

      // === SECOND API CALL (MODIFIED) ===
      const finalResponse = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          // 🚀 FIX 5: Send the 'messages' array, which now contains the full conversation
          // (system, user, assistant tool call, tool result)
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
      // No tool call was made, just return the direct reply
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
// === END OF CORRECTED /chat ENDPOINT ===

app.get("/skills/analyze", async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: "User ID required." });
    try {
        const userPrefs = await fetchUserPreferences(uid);
        if (!userPrefs || !userPrefs.jobRole)
            return res
                .status(404)
                .json({ error: "User profile or jobRole missing." });

        const userSkills = (userPrefs.skills || "")
            .toLowerCase()
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const jobRole = userPrefs.jobRole;

        // --- 1. Get Required Skills (Original Logic, remains unchanged) ---
        const skillsQuestion = `
List the top 8 most important technical skills for a '${jobRole}'.
Respond ONLY with a comma-separated list.
Each skill must be **only one or two words maximum** (e.g., 'Java', 'React Native', 'Data Analysis').
Do not include explanations, numbers, or symbols.
`;
        const skillsResp = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
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

        // --- 2. Get Learning Resources (FIXED Logic) ---
        const learningResources = {};
        for (const skill of missingSkills) {
            const resourceQuestion = `Provide a reputable, public URL for learning '${skill}'. Reply only with the URL.`;
            try {
                const resourceResp = await fetch("https://api.openai.com/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    },
                    // ❌ FIX 1: Removed the incorrect 'section' wrapper
                    body: JSON.stringify({
                        model: AI_MODEL,
                        messages: [{ role: "user", content: resourceQuestion }],
                    }),
                });

                const resourceData = await resourceResp.json();
                
                // Start with the raw string and aggressively clean it
                let url = (resourceData?.choices?.[0]?.message?.content || "").trim();
                
                // 🚀 FIX 2: Aggressive cleanup to remove unwanted characters (quotes, markdown backticks, spaces)
                url = url.replace(/["'`\s]/g, '');

                // 🚀 FIX 3: Ensure the URL has a protocol and a domain before saving
                if (url && url.includes('.')) {
                    // Prepend HTTPS if protocol is missing (e.g., if it returned 'udemy.com/course')
                    if (!url.startsWith("http://") && !url.startsWith("https://")) {
                        url = "https://" + url;
                    }
                    if (url.startsWith("http")) { // Final check after prepending
                        learningResources[skill] = url;
                    }
                }

            } catch (err) {
                // Ignore individual resource errors but log them
                console.error(`Error fetching resource for ${skill}:`, err.message);
            }
        }

        // --- 3. Return Final Results ---
        return res.json({
            jobRole,
            requiredSkills,
            missingSkills,
            learningResources,
        });
    } catch (err) {
        console.error("Error in /skills/analyze:", err);
        return res.status(500).json({ error: "Skill analysis failed." });
    }
});

app.get("/jobs", async (req, res) => {
  const { uid, q, employment_types } = req.query;
  try {
    let query = q;
    if (!query && uid) {
      const prefs = await fetchUserPreferences(uid);
      query = prefs
        ? `${prefs.skills || "jobs"} in ${prefs.location || "India"}`
        : "tech jobs in India";
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


// --- ✅ ADD THIS NEW ENDPOINT FOR STUDY ABROAD GUIDES ---
app.get("/counseling/custom-guide", async (req, res) => {
    const { fromCountry, toCountry, degree, topics } = req.query;
    console.log(`[Custom Guide] Request: ${fromCountry} to ${toCountry} for ${degree}`);
    console.log(`[Custom Guide] Topics: ${topics}`);

    if (!fromCountry || !toCountry || !degree || !topics) {
        return res.status(400).json({ 
            error: "Missing required fields. Please provide fromCountry, toCountry, degree, and topics." 
        });
    }
    
    const requestedTopics = topics.split(',');

    // --- DYNAMIC PROMPT (Unchanged) ---
    let contentInstructions = "The \"content\" field MUST be a detailed Markdown guide. ONLY include the following sections:\n";
    let universityInstructions = "The \"universities\" field MUST be an empty array [].";

    if (requestedTopics.includes("Admission Requirements")) {
        contentInstructions += "1.  **Admission Requirements:** General requirements for a student from ${fromCountry} (e.g., typical GPA, required tests like GRE/GMAT, language tests like IELTS/TOEFL, required documents like SOP/LORs).\n";
    }
    if (requestedTopics.includes("Estimated Annual Cost")) {
        contentInstructions += "2.  **Estimated Annual Cost:** Provide a realistic estimated range for Tuition and Living Expenses. *You MUST specify the currency* (e.g., USD, CAD, GBP).\n";
    }
    if (requestedTopics.includes("Visa Process")) {
        contentInstructions += "3.  **Visa Process:** Provide the *official name* of the student visa (e.g., F-1, Study Permit) and 2-3 key, actionable steps for a student from ${fromCountry} (e.g., 'Receive I-20/LOA', 'Pay SEVIS Fee', 'Provide Proof of Funds').\n";
    }
    if (requestedTopics.includes("Scholarship Opportunities")) {
        contentInstructions += "4.  **Scholarship Opportunities:** List 2-4 major, non-generic scholarships available for students from ${fromCountry}. *You MUST include a direct, valid, clickable Markdown link* to the official scholarship page for each one.\n";
    }
    if (requestedTopics.includes("Post-Study Work Options")) {
        contentInstructions += "5.  **Post-Study Work Options:** A 2-4 sentence summary of post-graduation work opportunities. Include the *official permit name* (e.g., OPT, PGWP) and its typical duration.\n";
    }
    if (requestedTopics.includes("Top Universities")) {
        universityInstructions = "The \"universities\" field MUST be a JSON array of 3-5 objects. Each object MUST have \"name\" (official university name), \"location\" (City, State/Province), and \"link\" (the *direct international admissions/application URL*, NOT the homepage).";
        contentInstructions += "6.  **Top Universities:** Briefly mention the universities you are providing in the 'universities' JSON array.\n";
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
    // --- END DYNAMIC PROMPT ---

    // 3. Call OpenAI
    try {
        const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
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
        });

        const data = await openAiResponse.json();
        if (!openAiResponse.ok || !data?.choices?.[0]?.message?.content) {
            throw new Error("Failed to get guide from AI model.");
        }

        let rawContent = data.choices[0].message.content.trim();
        
        // 4. Clean and Parse JSON
        try {
            // Step 1: Remove markdown wrapper if present
            const jsonMatch = rawContent.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[1]) {
                rawContent = jsonMatch[1].trim();
            }
            
            // 🚀 CRITICAL FIX: REMOVED the line that was breaking the JSON.
            // We now parse 'rawContent' directly.
            
            const finalData = JSON.parse(rawContent);

            res.json({
                content: finalData.content || "", 
                universities: finalData.universities || [] 
            });

        } catch (parseError) {
            console.error("[Custom Guide] Failed to parse AI JSON response:", parseError);
            console.error("[Custom Guide] Attempted to parse:", rawContent); // This log is now the one that failed
            throw new Error("AI model returned an unparsable JSON structure.");
        }

    } catch (error) {
        console.error("Error in /counseling/custom-guide:", error);
        res.status(500).json({ error: error.message || "Failed to generate custom guide." });
    }
});

app.get("/counseling/get-specializations", async (req, res) => {
    const { degree } = req.query;
    if (!degree) {
        return res.status(400).json({ error: "Degree is required." });
    }
    console.log(`[Get Specializations] Request received for: ${degree}`);

    const prompt = `
        List the top 10-15 most common specializations for a "${degree}" degree.
        If the degree is very general (like "Bachelor of Arts") list common majors.
        If the degree is already specific (like "PhD"), list common research areas.
        Respond ONLY with a valid JSON array of strings.
        Example: ["Computer Science", "Electrical Engineering", "Data Science"]
    `;

    try {
        const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
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
        });

        const data = await openAiResponse.json();
        const content = data.choices[0].message.content;
        
        // Try to parse the JSON array
        const specializationsList = JSON.parse(content);
        
        res.json({ specializations: specializationsList }); // Send the array

    } catch (err) {
        console.error(`Error fetching specializations for ${degree}:`, err);
        // If it fails, just return an empty list so the app hides the field
        res.json({ specializations: [] });
    }
});

app.get("/counseling/get-degrees", async (req, res) => {
    console.log("[Get Degrees] Request received.");

    // This prompt asks the AI to act as the database
    const prompt = `
        List the 80 most common academic and professional degrees for international study, sorted alphabetically.
        Respond ONLY with a valid JSON array of strings.
        Example: ["Bachelor of Arts", "Bachelor of Science", "Master of Business Administration"]
    `;

    try {
        const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-3.5-turbo", // A fast model is good for this
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1, // Low temperature for factual, clean list
            }),
        });

        const data = await openAiResponse.json();
        const content = data.choices[0].message.content;
        
        // Try to parse the JSON array directly from the response
        const degreesList = JSON.parse(content);
        
        res.json({ degrees: degreesList }); // Send the array

    } catch (err) {
        console.error("Error fetching degrees from AI:", err);
        res.status(500).json({ error: "Failed to fetch degree list." });
    }
});
app.get("/interview-prep/get-stats", async (req, res) => {
    const { uid } = req.query; // Get uid from query param
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

/**
 * 💡 Feature 9/10: Increment a User Stat
 * Atomically increments a specific stat for a user.
 */
app.post("/interview-prep/increment-stat", async (req, res) => {
    const { uid, statName } = req.body; // e.g., statName: "hrAnswersCompleted"
    
    if (!uid || !statName) {
        return res.status(400).json({ error: "uid and statName are required." });
    }

    // List of allowed stat names to prevent abuse
    const allowedStats = [
        "hrAnswersCompleted",
        "starStoriesSaved",
        "techQuestionsPracticed",
        "mockInterviewsRecorded",
        "companyNotesCreated"
    ];

    if (!allowedStats.includes(statName)) {
        return res.status(400).json({ error: "Invalid statName." });
    }

    try {
        const statsRef = db.collection("user_stats").doc(uid);
        
        // This is an atomic "read-modify-write" operation.
        // It's safe from race conditions.
        await statsRef.update({
            [statName]: admin.firestore.FieldValue.increment(1)
        });

        res.status(200).json({ message: `Stat ${statName} incremented.` });

    } catch (err) {
        // Handle case where doc doesn't exist yet
        if (err.code === 5) { // 'NOT_FOUND'
             try {
                // Create the doc with the first stat
                const defaultStats = {
                    hrAnswersCompleted: 0,
                    starStoriesSaved: 0,
                    techQuestionsPracticed: 0,
                    mockInterviewsRecorded: 0,
                    companyNotesCreated: 0,
                    [statName]: 1 // Set the one we're incrementing
                };
                await db.collection("user_stats").doc(uid).set(defaultStats);
                return res.status(200).json({ message: `Stat ${statName} incremented.` });
             } catch (createErr) {
                console.error("Error creating stats doc:", createErr);
                return res.status(500).json({ error: "Failed to create stats." });
             }
        }
        console.error("Error in /increment-stat:", err);
        res.status(500).json({ error: "Failed to increment stat." });
    }
});

// =================================================================
// === 🚀 NEW INTERVIEW PREP ENDPOINTS (Features 1, 2, 3, 6, 7) ===
// =================================================================

/**
 * Helper function to make a simple OpenAI call and return the text content
 */
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
        throw error; // Re-throw to be caught by the endpoint's catch block
    }
}

/**
 * 💡 Feature 1 & 2: Get Interview Questions
 * Generates a list of questions for a specific category and job role.
 */
app.get("/interview-prep/questions", async (req, res) => {
    const { category, jobRole = "general", count = 10 } = req.query;

    if (!category) {
        return res.status(400).json({ error: "Category is required (e.g., HR, Technical)." });
    }

    const prompt = `
        You are an expert interview coach.
        Generate ${count} ${category} interview questions for a ${jobRole} candidate.
        Respond ONLY with a valid JSON array of strings.
        Example: ["Question 1", "Question 2"]
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

/**
 * 💡 Feature 6: Get Daily Tip
 * Provides a single, random interview tip.
 */
app.get("/interview-prep/daily-tip", async (req, res) => {
    const prompt = `
        You are an expert career coach. 
        Provide one concise, actionable interview tip (2 sentences max).
        Respond ONLY with the text of the tip.
    `;
    try {
        const tip = await simpleOpenAICall(prompt, AI_MODEL, 0.8);
        res.json({ tip: tip });
    } catch (err) {
        console.error("Error in /interview-prep/daily-tip:", err);
        res.status(500).json({ error: "Failed to get daily tip." });
    }
});

/**
 * 💡 Feature 7: Generate Thank-You Email
 * Creates a template based on user inputs.
 */
app.post("/interview-prep/generate-email", async (req, res) => {
    const { jobTitle, companyName, tone = "formal" } = req.body;
    if (!jobTitle || !companyName) {
        return res.status(400).json({ error: "jobTitle and companyName are required." });
    }

    const prompt = `
        You are a professional career writer. 
        Write a concise thank-you email template for an interview for a ${jobTitle} position at ${companyName}.
        The tone should be ${tone}.
        Include placeholders like [Interviewer Name] and [Specific Point Discussed].
        Respond ONLY with the full email text (including subject).
        Example:
        Subject: Thank You - Interview for [Job Title]

        Dear [Interviewer Name],
        ...
    `;
    try {
        const template = await simpleOpenAICall(prompt, AI_MODEL, 0.5);
        res.json({ template: template });
    } catch (err) {
        console.error("Error in /interview-prep/generate-email:", err);
        res.status(500).json({ error: "Failed to generate email template." });
    }
});
// =================================================================
// === 🚀 NEW INTERVIEW PREP ENDPOINTS (Features 1, 2, 3, 6, 7) ===
// =================================================================

// ... (your existing simpleOpenAICall helper)

// ... (your existing /questions, /daily-tip, /generate-email, etc. endpoints)

/**
 * 💡 Feature 6: Get a large list of tips for caching
 * Generates a list of tips for the app to store locally.
 */

// ... (inside the "NEW INTERVIEW PREP ENDPOINTS" section)

/**
 * 💡 Feature 1/4: Delete a User Prep Data item
 * A generic endpoint to delete a specific item (e.g., a checklist task)
 */
app.delete("/users/:uid/prep-data", async (req, res) => {
    const { uid } = req.params;
    const { dataType, dataId } = req.body; // e.g., dataType: "checklist", dataId: "..."

    if (!uid || !dataType || !dataId) {
        return res.status(400).json({ error: "uid, dataType, and dataId are required." });
    }
    
    try {
        await db.collection("users").doc(uid)
                .collection("interview_prep").doc(dataType)
                .collection("items").doc(dataId)
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
        You are an expert career coach.
        Generate ${count} unique, concise, and actionable interview tips.
        Each tip should be one or two sentences.
        Respond ONLY with a valid JSON array of strings.
        Example: ["Tip 1...", "Tip 2...", "Tip 3..."]
    `;

    try {
        let tipsJson = await simpleOpenAICall(prompt, AI_MODEL, 0.8);
        
        // --- FIX: Clean markdown wrapper if AI adds it ---
        const jsonMatch = tipsJson.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
            tipsJson = jsonMatch[1].trim();
        }
        // --- END FIX ---
        
        const tipsList = JSON.parse(tipsJson); // The prompt forces JSON
        res.json({ tips: tipsList });
    } catch (err) {
        console.error("Error in /interview-prep/tips-list:", err);
        console.error("Failed to parse this JSON:", tipsJson); 
        res.status(500).json({ error: "Failed to generate tips list." });
    }
});
/**
 * 💡 Feature 3: Evaluate STAR Method Answer
 * Provides feedback on a S-T-A-R story.
 */
/**
 * 💡 Feature 3: Evaluate STAR Method Answer
 * Provides feedback on a S-T-A-R story.
 */
app.post("/interview-prep/evaluate-star", async (req, res) => {
    const { situation, task, action, result } = req.body;
    if (!situation || !task || !action || !result) {
        return res.status(400).json({ error: "All four STAR fields are required." });
    }

    const prompt = `
        You are an expert HR manager. Evaluate this STAR method answer:
        Situation: ${situation}
        Task: ${task}
        Action: ${action}
        Result: ${result}

        Provide concise feedback. Respond ONLY with a valid JSON object in this exact format:
        {
            "strength": "What was strong about this answer (1-2 sentences).",
            "weakness": "What was weak or missing (1-2 sentences).",
            "suggestion": "A specific suggestion for improvement (1-2 sentences)."
        }
    `;
    try {
        let feedbackJson = await simpleOpenAICall(prompt, "gpt-4o", 0.4);

        // 💡 --- START FIX ---
        // Clean the string to remove markdown wrappers (```json ... ```)
        // that the AI sometimes adds.
        const jsonMatch = feedbackJson.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
            feedbackJson = jsonMatch[1].trim();
        }
        // 💡 --- END FIX ---

        const feedback = JSON.parse(feedbackJson); // This will now work
        res.json(feedback);
    } catch (err) {
        console.error("Error in /interview-prep/evaluate-star:", err);
        // Log the raw string that failed to parse
        console.error("Failed to parse this JSON:", feedbackJson); 
        res.status(500).json({ error: "Failed to evaluate STAR answer." });
    }
});

/**
 * 💡 Feature 2: Evaluate Practice Answer (Mock Interview / Self-Assessment)
 * Provides feedback on a user's answer to a specific question.
 */
app.post("/interview-prep/evaluate-answer", async (req, res) => {
    const { question, answer } = req.body;
    if (!question || !answer) {
        return res.status(400).json({ error: "Question and answer are required." });
    }

    const prompt = `
        You are an interview coach. 
        The question was: "${question}"
        The user's answer was: "${answer}"

        Provide concise, constructive feedback on the answer's clarity, structure, and impact (3-4 sentences total).
        Start with one positive point, then one area for improvement.
        Respond ONLY with the feedback text.
    `;
    try {
        const feedback = await simpleOpenAICall(prompt, AI_MODEL, 0.5);
        res.json({ feedback: feedback });
    } catch (err) {
        console.error("Error in /interview-prep/evaluate-answer:", err);
        res.status(500).json({ error: "Failed to evaluate answer." });
    }
});

/**
 * 💡 Feature 4, 5, 9: Save/Load User Prep Data
 * A generic endpoint to save company notes, checklist status, saved STAR stories, etc.
 */
app.post("/users/:uid/prep-data", async (req, res) => {
    const { uid } = req.params;
    const { dataType, dataId, data } = req.body; // e.g., dataType: "companyNote", dataId: "google", data: { ... }
                                            // e.g., dataType: "checklist", dataId: "main", data: { "resume": true, "star": false }

    if (!dataType || !dataId || !data) {
        return res.status(400).json({ error: "dataType, dataId, and data are required." });
    }
    
    try {
        await db.collection("users").doc(uid)
                .collection("interview_prep").doc(dataType) // e.g., "companyNotes", "checklists"
                .collection("items").doc(dataId) // e.g., "google", "main"
                .set(data, { merge: true }); // Use merge to update or create
        
        res.status(201).json({ message: `${dataType} saved.` });
    } catch (err) {
        console.error("Error saving prep-data:", err);
        res.status(500).json({ error: `Could not save ${dataType}.` });
    }
});

/**
 * 💡 Feature 4, 5, 9: Get User Prep Data
 * A generic endpoint to get all data of a certain type (e.g., all company notes)
 */
app.get("/users/:uid/prep-data", async (req, res) => {
    const { uid } = req.params;
    const { dataType } = req.query; // e.g., dataType: "companyNote"

    if (!dataType) {
        return res.status(400).json({ error: "dataType is required." });
    }
    
    try {
        const snap = await db.collection("users").doc(uid)
                             .collection("interview_prep").doc(dataType)
                             .collection("items").get();
        
        const allData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json(allData);
    } catch (err) {
        console.error("Error fetching prep-data:", err);
        res.status(500).json({ error: `Could not fetch ${dataType}.` });
    }
});
// ... (inside the "NEW INTERVIEW PREP ENDPOINTS" section)

/**
 * 💡 Feature 8 (Improved): Get Technical Questions
 * Generates a list of technical questions based on user's job role and skills,
 * complete with the *best* direct URL to practice or learn about that question.
 */
app.get("/interview-prep/technical-questions", async (req, res) => {
    const { uid, count = 15 } = req.query;

    if (!uid) {
        return res.status(400).json({ error: "User ID (uid) is required." });
    }

    // 1. Fetch user's profile from Firebase
    let jobRole = "Software Engineer"; // Default
    let skills = "Data Structures and Algorithms"; // Default
    try {
        const userPrefs = await fetchUserPreferences(uid); // You already have this helper
        if (userPrefs) {
            jobRole = userPrefs.jobRole || jobRole;
            skills = userPrefs.skills || skills;
        }
    } catch (err) {
        console.warn("Could not fetch user profile for tech questions, using defaults.");
    }
    
    // 2. Create the NEW AI Prompt
    const prompt = `
        You are an expert technical interviewer and career coach.
        A candidate has the job role of "${jobRole}" and lists these skills: "${skills}".
        
        Generate ${count} relevant technical interview questions for this candidate.
        For each question, find the single **best, high-quality URL** on the internet to practice or learn about that specific question.
        This could be a link to LeetCode, HackerRank, GeeksforGeeks, a technical blog, or official documentation.
        The URL must be direct and fully-qualified (e.g., "https://leetcode.com/problems/reverse-linked-list/").

        Respond ONLY with a valid JSON array of objects.
        Example format:
        [
          {
            "question": "Reverse a Linked List",
            "url": "https://leetcode.com/problems/reverse-linked-list/"
          },
          {
            "question": "What is the difference between an abstract class and an interface in Java?",
            "url": "https://www.geeksforgeeks.org/difference-between-abstract-class-and-interface-in-java/"
          },
          {
            "question": "Binary Tree Inorder Traversal",
            "url": "https://www.hackerrank.com/challenges/tree-inorder-traversal/problem"
          }
        ]
    `;

    // 3. Call OpenAI and return response
    try {
        let questionsJson = await simpleOpenAICall(prompt, "gpt-4o", 0.6); // Use a strong model
        
        // --- FIX: Clean markdown wrapper if AI adds it ---
        const jsonMatch = questionsJson.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
            questionsJson = jsonMatch[1].trim();
        }
        // --- END FIX ---
        
        const questionsList = JSON.parse(questionsJson);
        res.json(questionsList); // Send the array directly
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