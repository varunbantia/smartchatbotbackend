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
// 1. CONFIGURATION & INITIALIZATION
// =================================================================

const app = express();
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });

const AI_MODEL = "gpt-3.5-turbo";

let sttClient;

// ✅ Using the robust, standard initialization for production environments like Render
try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: 'smartchatbot-24e6b', // Your explicit Project ID
  });
  console.log("✅ Firebase Admin initialized successfully.");
  
  sttClient = new speech.SpeechClient();
  console.log("✅ Google Speech-to-Text client initialized successfully.");
} catch (err) {
  console.error("🔥 Google Cloud initialization failed:", err);
  process.exit(1);
}


// =================================================================
// 2. MOCK DATABASE & HELPER FUNCTIONS
// =================================================================

// Mock 'jobs' array for easy testing
const jobs = [
    { id: 1, title: "Junior App Developer", company: "Innovate Mobile", skills: ["java", "kotlin", "android"], location: "bengaluru", experience: "fresher", description: "Join a vibrant team to build the next generation of our mobile applications. Perfect for a recent graduate passionate about mobile technology." },
    { id: 2, title: "Java Developer", company: "Tech-Infra Systems", skills: ["java", "spring", "sql"], location: "bengaluru", experience: "2 years", description: "Build and maintain scalable backend services using Java and the Spring framework. Responsible for API design and database management." },
    { id: 3, title: "Python Developer", company: "DataLeap Analytics", skills: ["python", "django", "api"], location: "pune", experience: "1 year", description: "Work with the Django framework to build robust RESTful APIs for our data platform." },
    { id: 4, title: "Software Engineer (Entry-Level)", company: "Core Systems Inc.", skills: ["java", "python", "dsa"], location: "bengaluru", experience: "fresher", description: "An exciting entry-level position for a recent graduate. Strong foundation in data structures and algorithms is essential." },
    { id: 5, title: "UI/UX Designer", company: "PixelPerfect", skills: ["figma", "sketch", "prototyping"], location: "remote", experience: "3 years", description: "Create intuitive and beautiful user experiences for our web and mobile products. A strong portfolio is required." }
];

/**
 * Fetches a user's profile from Firestore using their UID.
 */
const fetchUserPreferences = async (uid) => {
    if (!uid) return null;
    try {
        const userDoc = await admin.firestore().collection('users').doc(uid).get();
        return userDoc.exists ? userDoc.data() : null;
    } catch (error) {
        console.error("Error fetching user from Firestore:", error);
        return null;
    }
};

/**
 * Filters the mock job list based on provided parameters.
 */
const findJobs = (params) => {
    const { skills, location } = params;
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

/**
 * Finds a specific job from the mock list by its ID.
 */
const getJobDetails = (params) => {
    const { jobId } = params;
    if (typeof jobId !== 'number') return { error: "Invalid jobId provided." };
    const job = jobs.find(j => j.id === jobId);
    return job || { error: `Job with ID ${jobId} not found.` };
};

// =================================================================
// 3. AI TOOLS (FUNCTION CALLING) DEFINITION
// =================================================================

// ✅ The 'get_job_details' tool is now correctly included.
const tools = [
  {
    type: "function",
    function: {
      name: "find_jobs",
      description: "Searches for available jobs based on criteria like skills or location.",
      parameters: {
        type: "object",
        properties: {
          skills: { type: "string", description: "A comma-separated list of skills" },
          location: { type: "string", description: "The desired job location" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
        name: "get_job_details",
        description: "Gets detailed information about a specific job using its unique job ID.",
        parameters: {
            type: "object",
            properties: { jobId: { type: "number", description: "The unique ID of the job." } },
            required: ["jobId"],
        },
    },
  },
  {
      type: "function",
      function: {
          name: "get_user_info",
          description: "Retrieves the current user's complete profile information from the database.",
          parameters: { type: "object", properties: {}, required: [] },
      },
  }
];

// =================================================================
// 4. API ENDPOINTS
// =================================================================

app.post("/stt", upload.single("audio"), async (req, res) => { /* ... Unchanged ... */ });

app.post("/chat", async (req, res) => {
    const { message, history, uid, language } = req.body;
    if (!uid) return res.status(400).json({ error: "User ID (uid) is missing." });

    try {
        const userPrefs = await fetchUserPreferences(uid);
        let personalizationContext = "";
        if (userPrefs) {
             personalizationContext = `For personalization, use the current user's profile: Name: ${userPrefs.name || 'N/A'}, Skills: ${userPrefs.skills || 'N/A'}, Experience: ${userPrefs.experience || 'N/A'}.`;
        }
        
        const languageInstruction = `Respond in ${language || 'English'}.`;
        const systemPrompt = `You are RozgarAI, a friendly and conversational AI career advisor.
- When you use 'find_jobs', present the results conversationally. Always mention each job's unique ID in parentheses, like this: "Java Developer (ID: 2)".
- If the user asks for "more details", use the 'get_job_details' function with the corresponding job ID.
- Use the user's profile from the personalization context to tailor your responses.
- Language: ${languageInstruction}`;
        
        const transformedHistory = (Array.isArray(history) ? history : [])
            .filter(msg => msg.message)
            .map(msg => {
                const role = (msg.type === 1) ? "assistant" : "user";
                return { role: role, content: msg.message };
            });

        const messages = [
            { role: "system", content: systemPrompt },
            ...transformedHistory,
            { role: "user", content: message || "..." },
        ];
        
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
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
            
            // ✅ The 'get_job_details' case is now correctly included.
            switch(functionName) {
                case 'find_jobs':
                    toolResult = findJobs(functionArgs);
                    break;
                case 'get_job_details':
                    toolResult = getJobDetails(functionArgs);
                    break;
                case 'get_user_info':
                    toolResult = await fetchUserPreferences(uid);
                    break;
                default:
                    toolResult = { error: "Function not implemented." };
            }

            const finalMessages = [...messages, firstResponseMsg, {
                tool_call_id: toolCall.id, role: "tool", name: functionName, content: JSON.stringify(toolResult),
            }];

            const finalResponse = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
                body: JSON.stringify({ model: AI_MODEL, messages: finalMessages }),
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