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
// INITIALIZATION
// =================================================================

const app = express();
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });

// --- Initialize Firebase Admin ---
// IMPORTANT: Make sure your .env file has the FIREBASE_SERVICE_ACCOUNT_JSON variable
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("✅ Firebase Admin initialized successfully.");
} catch (err) {
  console.error("🔥 Firebase Admin initialization failed:", err);
}

// --- Initialize Google Cloud STT client ---
let sttClient;
try {
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  sttClient = credentialsJson
    ? new speech.SpeechClient({ credentials: JSON.parse(credentialsJson) })
    : new speech.SpeechClient();
  console.log("✅ Google Speech-to-Text client initialized.");
} catch (err) {
  console.error("🔥 Google Speech-to-Text client failed to initialize:", err);
  sttClient = null;
}


// =================================================================
// MOCK DATABASE & HELPER FUNCTIONS
// =================================================================

// --- Mock Job Database (Replace with your actual database calls) ---
const jobs = [
    { id: 1, title: "Senior Python Developer", skills: ["python", "django", "sql"], location: "chandigarh", experience: "5 years" },
    { id: 2, title: "Frontend Developer (React)", skills: ["react", "javascript", "css"], location: "mohali", experience: "2 years" },
    { id: 3, title: "Data Scientist", skills: ["python", "machine learning", "tensorflow"], location: "remote", experience: "3 years" },
    { id: 4, title: "Junior Java Developer", skills: ["java", "spring"], location: "chandigarh", experience: "1 year" },
];

// --- Helper to fetch user preferences from Firestore ---
const fetchUserPreferences = async (uid) => {
    if (!uid) return null;
    try {
        const userDoc = await admin.firestore().collection('users').doc(uid).get();
        if (userDoc.exists) {
            return userDoc.data();
        }
        return null;
    } catch (error) {
        console.error("Error fetching user from Firestore:", error);
        return null;
    }
};

// --- Helper to find jobs from our mock database ---
const findJobs = (params) => {
    const { skills, location, experience } = params;
    let filteredJobs = jobs;

    if (skills) {
        const skillArray = skills.toLowerCase().split(',').map(s => s.trim());
        filteredJobs = filteredJobs.filter(job => 
            skillArray.some(skill => job.skills.includes(skill))
        );
    }
    if (location) {
        filteredJobs = filteredJobs.filter(job => job.location.toLowerCase() === location.toLowerCase());
    }
    
    return filteredJobs.length > 0 ? filteredJobs : "No jobs found matching those criteria.";
};

// =================================================================
// AI TOOLS (FUNCTION CALLING) DEFINITION
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
          location: { type: "string", description: "The desired job location, e.g., 'Chandigarh', 'Mohali', 'Remote'" },
          experience: { type: "string", description: "Required years of experience, e.g., '2 years', '5+'" },
        },
        required: [],
      },
    },
  },
  {
      type: "function",
      function: {
          name: "get_user_info",
          description: "Retrieves the user's profile information like their name, skills, and qualifications from the database.",
          parameters: { type: "object", properties: {}, required: [] },
      },
  }
];


// =================================================================
// API ENDPOINTS
// =================================================================

// --- Speech-to-Text Endpoint (Now with language support) ---
app.post("/stt", upload.single("audio"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Audio file is missing." });
    if (!sttClient) return res.status(500).json({ error: "Google Speech client not initialized." });

    // Get language from the request, default to English (India)
    const languageCode = req.body.languageCode || "en-IN";

    try {
        const audioBytes = fs.readFileSync(req.file.path).toString("base64");
        
        const config = {
            encoding: "AMR",
            sampleRateHertz: 8000,
            languageCode: languageCode, // Use dynamic language code
            alternativeLanguageCodes: ["en-IN", "hi-IN", "pa-IN"],
        };

        const [response] = await sttClient.recognize({ audio: { content: audioBytes }, config });
        const transcription = response.results?.map((r) => r.alternatives[0].transcript).join("\n") || "";

        fs.unlinkSync(req.file.path); // Cleanup uploaded file
        res.json({ text: transcription });

    } catch (err) {
        console.error("STT Error:", err);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: "Error transcribing audio" });
    }
});


// --- Chat Endpoint (Now with Personalization, Tools, and Language Support) ---
app.post("/chat", async (req, res) => {
    const { message, history, uid, language } = req.body;

    if (!message) return res.status(400).json({ error: "Message content is missing." });
    if (!uid) return res.status(400).json({ error: "User ID (uid) is missing for personalization." });

    try {
        // 1. Fetch user preferences for personalization
        const userPrefs = await fetchUserPreferences(uid);
        let personalizationContext = "";
        if (userPrefs) {
            personalizationContext = `For personalization, here is the current user's profile: Name is ${userPrefs.name}, their skills are ${userPrefs.skills}, and their preferred location is ${userPrefs.location}. Use this information to provide better recommendations.`;
        }

        // 2. Create a dynamic system prompt
        const languageInstruction = `Respond in ${language || 'English'}.`;
        const systemPrompt = `You are RozgarAI, a helpful and friendly AI assistant for the PGRKAM digital platform. Your goal is to assist users with job searches, skill development, and foreign counseling. ${personalizationContext} ${languageInstruction}`;
        
        const messages = [
            { role: "system", content: systemPrompt },
            ...(Array.isArray(history) ? history : []),
            { role: "user", content: message },
        ];
        
        // 3. First call to OpenAI to see if it wants to use a tool
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({ model: "gpt-3.5-turbo", messages, tools, tool_choice: "auto" }),
        });

        const data = await response.json();
        if (!data.choices || data.choices.length === 0) throw new Error("Invalid response from OpenAI.");

        const firstResponseMsg = data.choices[0].message;

        // 4. Check if the model wants to call a function
        if (firstResponseMsg.tool_calls) {
            const toolCall = firstResponseMsg.tool_calls[0];
            const functionName = toolCall.function.name;
            const functionArgs = JSON.parse(toolCall.function.arguments || "{}");
            
            let toolResult;
            
            // Execute the correct function
            switch(functionName) {
                case 'find_jobs':
                    toolResult = findJobs(functionArgs);
                    break;
                case 'get_user_info':
                    toolResult = await fetchUserPreferences(uid);
                    break;
                default:
                    toolResult = { error: "Function not implemented." };
            }

            // 5. Second call to OpenAI with the function result
            const finalMessages = [...messages, firstResponseMsg, {
                tool_call_id: toolCall.id,
                role: "tool",
                name: functionName,
                content: JSON.stringify(toolResult),
            }];

            const finalResponse = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
                body: JSON.stringify({ model: "gpt-3.5-turbo", messages: finalMessages }),
            });

            const finalData = await finalResponse.json();
            res.json({ reply: finalData.choices[0].message.content });

        } else {
            // If no function call, just return the direct reply
            res.json({ reply: firstResponseMsg.content });
        }

    } catch (err) {
        console.error("Error in /chat endpoint:", err);
        res.status(500).json({ error: "An error occurred while processing your request." });
    }
});


// =================================================================
// START SERVER
// =================================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));