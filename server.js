import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";

// ✅ 1. IMPORT FIREBASE AND GOOGLE CLOUD
import admin from "firebase-admin";
import speech from "@google-cloud/speech";

dotenv.config();

// ✅ 2. CORRECTLY INITIALIZE SERVICES WITH CREDENTIALS
// Read credentials from the single environment variable
const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

// Initialize Firebase Admin SDK for Firestore access
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Initialize Google Speech Client with the same credentials
const client = new speech.SpeechClient({ credentials: serviceAccount });


const app = express();
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });

// ✅ 3. LIVE DATABASE FUNCTION
// This function queries your actual Firestore 'jobs' collection
async function getJobsFromDatabase({ location, keyword }) {
    console.log(`Querying Firestore for jobs. Location: ${location}, Keyword: ${keyword}`);
    try {
        let query = db.collection('jobs');
        if (location) {
            query = query.where('location', '==', location);
        }
        if (keyword) {
            const keywords = keyword.toLowerCase().split(/, |,/);
            query = query.where('requiredSkills', 'array-contains-any', keywords);
        }

        const snapshot = await query.get();
        if (snapshot.empty) {
            return JSON.stringify([]);
        }

        const jobs = [];
        snapshot.forEach(doc => {
            jobs.push({ id: doc.id, ...doc.data() });
        });
        
        return JSON.stringify(jobs);
    } catch (error) {
        console.error("Error fetching from Firestore:", error);
        return JSON.stringify({ error: "Failed to fetch jobs." });
    }
}

// ✅ 4. DEFINE THE TOOLS FOR THE LLM
const tools = [
    {
        type: "function",
        function: {
            name: "get_jobs",
            description: "Get a list of available jobs from the PGRKAM platform based on location and skills/keywords.",
            parameters: {
                type: "object",
                properties: {
                    location: { type: "string", description: "The city to search for jobs in." },
                    keyword: { type: "string", description: "A keyword or comma-separated list of skills." },
                },
                required: [],
            },
        },
    }
];

// ✅ 5. FINAL, INTELLIGENT CHAT ENDPOINT
app.post("/chat", async (req, res) => {
    const { history, userProfile } = req.body;

    let systemPrompt = `You are a helpful and encouraging assistant for the Punjab Ghar Ghar Rozgar and Karobar Mission (PGRKAM) digital platform. Your purpose is to help users with job searches, skill development, and foreign counseling.`;
    if (userProfile && userProfile.skills) {
        systemPrompt += ` The user you are speaking with has skills in: ${userProfile.skills}. Use this to provide personalized recommendations. If they ask for jobs, implicitly use their skills as keywords.`;
    }
    
    const messages = [
        { role: "system", content: systemPrompt },
        ...history
    ];

    try {
        const initialResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: "gpt-3.5-turbo",
                messages: messages,
                tools: tools,
                tool_choice: "auto",
            }),
        });

        const data = await initialResponse.json();
        const message = data.choices[0].message;

        if (message.tool_calls) {
            const toolCall = message.tool_calls[0];
            const functionName = toolCall.function.name;
            const functionArgs = JSON.parse(toolCall.function.arguments);

            const functionResult = await getJobsFromDatabase(functionArgs);

            const secondApiMessages = [ ...messages, message, { tool_call_id: toolCall.id, role: "tool", name: functionName, content: functionResult }];
            
            const finalResponse = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
                body: JSON.stringify({ model: "gpt-3.5-turbo", messages: secondApiMessages }),
            });

            const finalData = await finalResponse.json();
            res.json({ reply: finalData.choices[0].message.content });
        } else {
            res.json({ reply: message.content });
        }
    } catch (err) {
        console.error("Error in /chat endpoint:", err);
        res.status(500).send("Error connecting to OpenAI API");
    }
});

// Your /stt endpoint is correct but benefits from the credential fix
app.post("/stt", upload.single("audio"), async (req, res) => {
    // ... same logic as your file, it will now use the correctly initialized 'client'
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));