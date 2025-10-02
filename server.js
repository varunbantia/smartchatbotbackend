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

const app = express();
app.use(bodyParser.json());
const upload = multer({ dest: "uploads/" });
const AI_MODEL = "gpt-3.5-turbo";
let sttClient;

try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: 'smartchatbot-24e6b',
  });
  console.log("✅ Firebase Admin initialized successfully.");
  sttClient = new speech.SpeechClient();
  console.log("✅ Google Speech-to-Text client initialized successfully.");
} catch (err) {
  console.error("🔥 Google Cloud initialization failed:", err);
  process.exit(1);
}

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

const findJobs = async (params) => {
    try {
        const { skills, location } = params;
        const query = `${skills || 'jobs'} in ${location || 'India'}`;
        const url = new URL("https://jsearch.p.rapidapi.com/search");
        url.searchParams.append("query", query);
        url.searchParams.append("num_pages", "1");
        url.searchParams.append("page", "1");

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'X-RapidAPI-Key': process.env.JSEARCH_API_KEY,
                'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
            }
        });

        const result = await response.json();
        if (!result.data || result.data.length === 0) {
            return "I couldn't find any live job listings matching those criteria at the moment.";
        }

        const jobs = result.data.slice(0, 5).map(job => ({
            job_id: job.job_id,
            title: job.job_title,
            company: job.employer_name,
            location: `${job.job_city || ''}${job.job_city && job.job_state ? ', ' : ''}${job.job_state || ''}`,
            description: (job.job_description || 'No description available.').substring(0, 250) + '...',
            applicationLink: job.job_apply_link || `https://www.google.com/search?q=${encodeURIComponent(job.job_title + ' at ' + job.employer_name)}`
        }));
        
        return jobs;
    } catch (error) {
        console.error("Error finding jobs via Jsearch API:", error);
        return "Sorry, I encountered an error while searching for live jobs.";
    }
};

const tools = [
  {
    type: "function",
    function: {
      name: "find_jobs",
      description: "Searches for real, live job listings based on criteria like skills or location.",
      parameters: {
        type: "object",
        properties: {
          skills: { type: "string", description: "The job title or skills to search for, e.g., 'Python developer'" },
          location: { type: "string", description: "The desired job location, e.g., 'Bengaluru'" },
        },
        required: [],
      },
    },
  },
];

app.post("/chat", async (req, res) => {
    const { message, history, uid, language } = req.body;
    if (!uid) return res.status(400).json({ error: "User ID (uid) is missing." });

    try {
        const userPrefs = await fetchUserPreferences(uid);
        let personalizationContext = userPrefs ? `The user's name is ${userPrefs.name}, and their skills include ${userPrefs.skills}.` : '';
        const languageInstruction = `Respond in ${language || 'English'}.`;
        
        const systemPrompt = `You are RozgarAI, a helpful AI career advisor. 
- When a user asks to find jobs, use the 'find_jobs' tool.
- When presenting the jobs, list them conversationally. For each job, you MUST provide the title, company, location, and the applicationLink.
- Do NOT mention job IDs, as they are not needed. Guide the user to the application link for full details.
- ${personalizationContext} ${languageInstruction}`;
        
        const transformedHistory = (Array.isArray(history) ? history : [])
            .filter(msg => msg.message)
            .map(msg => {
                const role = (msg.type === 1) ? "assistant" : "user";
                return { role, content: msg.message };
            });

        const messages = [{ role: "system", content: systemPrompt }, ...transformedHistory, { role: "user", content: message || "..." }];
        
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
            if (functionName === 'find_jobs') {
                toolResult = await findJobs(functionArgs);
            } else {
                toolResult = { error: "Unknown function." };
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));