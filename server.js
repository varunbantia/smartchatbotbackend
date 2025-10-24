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
import path from 'path';         
import pkg from "pdf-parse";   // 👈 Add this
const pdfParse = pkg;          // 👈 Add this    
import mammoth from 'mammoth';

dotenv.config();

// =================================================================
// 1. CONFIGURATION & INITIALIZATION
// =================================================================

// ... (Your existing config code: app, upload, sttClient, firebase init, etc.) ...
// (No changes needed in section 1)
const app = express();
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
const upload = multer({ dest: "uploads/" });

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

const db = admin.firestore();

// =================================================================
// 2. HELPERS
// =================================================================

// ... (Your existing detectLanguageSimple, fetchUserPreferences, getCompanyLogo) ...
// (No changes needed to those helpers)
async function extractResumeText(filePath) {
  const fileExtension = path.extname(filePath).toLowerCase();
  console.log(`Attempting to extract text from file: ${filePath}, extension: ${fileExtension}`);

  try {
    if (fileExtension === '.pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      console.log(`Extracted ${data.text.length} characters from PDF.`);
      return data.text;
    } else if (fileExtension === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      console.log(`Extracted ${result.value.length} characters from DOCX.`);
      return result.value;
    } else if (fileExtension === '.doc') {
       console.warn("Extraction from .doc is not directly supported. User needs to save as .docx or .pdf.");
       throw new Error("Unsupported file format: .doc. Please use .docx or .pdf.");
    } else if (fileExtension === '.txt') {
        const text = fs.readFileSync(filePath, 'utf8');
        console.log(`Read ${text.length} characters from TXT.`);
        return text;
    }
    else {
      console.warn(`Unsupported file extension: ${fileExtension}`);
      throw new Error(`Unsupported file type: ${fileExtension}. Please upload PDF or DOCX.`);
    }
  } catch (error) {
    console.error(`Error extracting text from ${filePath}:`, error);
    // Rethrow specific errors or a generic one
    if (error.message.includes("Unsupported file type")) throw error;
    throw new Error(`Failed to read or parse the resume file.`);
  }
}

// --- NEW HELPER: Get Resume Feedback from AI ---
async function getResumeFeedback(resumeText) {
    if (!resumeText || resumeText.trim().length < 50) { // Basic check for meaningful text
        throw new Error("Extracted resume text is too short or empty.");
    }

    const analysisPrompt = `Please act as an expert career coach and resume reviewer. Analyze the following resume text and provide constructive feedback. Focus on:
1.  **Clarity & Conciseness:** Is the language clear and easy to understand? Is there unnecessary jargon?
2.  **Impact & Achievements:** Does the candidate effectively showcase accomplishments using action verbs and quantifiable results (numbers, percentages)? Suggest specific areas where impact could be highlighted better.
3.  **Keywords & ATS:** Are relevant keywords likely present for common Applicant Tracking Systems (ATS)? Suggest potential keywords based on typical roles if missing.
4.  **Formatting & Structure (Inferred):** Based *only* on the text content, does the flow seem logical? (Acknowledge you cannot see the actual visual format).
5.  **Common Mistakes:** Point out any obvious errors like potential typos (mention if unsure), generic statements, or lack of tailoring (if inferrable).
6.  **Overall Summary:** A brief concluding thought on the resume's strengths and primary areas for improvement.

Format the feedback clearly using markdown headings or bullet points for readability. Be encouraging but direct.

Resume Text:
---
${resumeText}
---
`;

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
 * Formats experience data from JSearch job object
 */
/**
 * Formats experience data from JSearch job object (with text fallback)
 */
// ... (near your other helper functions)

/**
 * Cleans a job description by removing duplicate lines.
 */
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
const findJobs = async (params) => {
  try {
    const { query, employment_types } = params || {};
    if (!query || query.trim() === "") return [];

    const url = new URL("https://jsearch.p.rapidapi.com/search");
    url.searchParams.append("query", query);
    if (employment_types)
      url.searchParams.append(
        "employment_types",
        (employment_types || "").toUpperCase()
      );
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
    const jobs = await Promise.all(
      result.data.slice(0, 7).map(async (job) => {
        const logoUrl = await getCompanyLogo(
          job.employer_name,
          job.employer_logo
        );
        const location = `${job.job_city || ""}${
          job.job_city && job.job_state ? ", " : ""
        }${job.job_state || ""}`.trim();
        const cleanDescription = cleanJobDescription(job.job_description);
        return {
          // --- Existing Fields ---
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
            )}`, // --- NEW FIELDS ADDED ---
          salary: formatSalary(job),
          jobType: getJobType(job),
          experience: getExperience(job),
        };
      })
    );

    return jobs;
  } catch (err) {
    console.error("Error in findJobs:", err);
    return [];
  }
};

// =================================================================
// 3. Tools configuration
// =================================================================

// ... (Your existing 'tools' array) ...
// (No changes needed)
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

// ... (Your existing endpoints: /stt, /chat, /skills/analyze, /jobs, etc.) ...
// (No changes needed in section 4)
app.post("/analyze-resume", upload.single("resumeFile"), async (req, res) => {
  // Check if file was uploaded
  if (!req.file) {
    return res.status(400).json({ error: "No resume file uploaded." });
  }

  // Optional: Authenticate user if needed (e.g., using Firebase ID token)
  // const idToken = req.headers.authorization?.split('Bearer ')[1];
  // if (!idToken) return res.status(401).json({ error: "Unauthorized: Missing token" });
  // try {
  //   const decodedToken = await admin.auth().verifyIdToken(idToken);
  //   req.user = decodedToken; // Add user info to request if needed later
  // } catch (error) {
  //   console.error("Error verifying token:", error);
  //   return res.status(401).json({ error: "Unauthorized: Invalid token" });
  // }

  const filePath = req.file.path;
  console.log(`Received resume file for analysis: ${filePath} (Original: ${req.file.originalname})`);

  try {
    // 1. Extract Text
    const resumeText = await extractResumeText(filePath);

    // 2. Get Feedback from AI
    const analysisResult = await getResumeFeedback(resumeText);

    // 3. Send successful response
    res.json({ analysisResult: analysisResult });

  } catch (error) {
    console.error("Error during resume analysis:", error);
    // Send specific error messages based on the error type
    if (error.message.includes("Unsupported file type") || error.message.includes("Unsupported file format")) {
        res.status(400).json({ error: error.message });
    } else if (error.message.includes("too short or empty")) {
         res.status(400).json({ error: "Could not extract meaningful text from the resume. Please check the file." });
    }
     else {
        res.status(500).json({ error: "Failed to analyze resume. " + error.message });
    }
  } finally {
    // 4. Clean up the uploaded file ALWAYS
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
          functions: tools.map((t) => (t.function ? t.function : t)),
          function_call: "auto",
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
      const messagesWithTool = [
        ...messages,
        firstMsg,
        {
          role: "tool",
          name: functionName,
          content: JSON.stringify(toolResult),
        },
      ];
      const finalResponse = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({ model: AI_MODEL, messages: messagesWithTool }),
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
    const learningResources = {};
    for (const skill of missingSkills) {
      const resourceQuestion = `Provide a reputable, public URL for learning '${skill}'. Reply only with the URL.`;
      try {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          section: {
            body: JSON.stringify({
              model: AI_MODEL,
              messages: [{ role: "user", content: resourceQuestion }],
            }),
          },
        });
        const d = await r.json();
        const url = (d?.choices?.[0]?.message?.content || "").trim();
        if (url.startsWith("http")) learningResources[skill] = url;
      } catch (err) {}
    }
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

// =================================================================
// 5. START SERVER
// =================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
