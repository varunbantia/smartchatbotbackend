// src/controllers/chatController.js
import { getJobsFromDatabase } from "../services/firestoreService.js";
import { callOpenAI } from "../services/openAIService.js";

const tools = [
  {
    type: "function",
    function: {
      name: "get_jobs",
      description: "Get jobs from Firestore based on location and skills/keywords.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          keyword: { type: "string" },
        },
        required: [],
      },
    },
  },
];

export async function handleChatRequest(req, res, next) {
  try {
    const { history, userProfile } = req.body;

    // --- ✅ Input Validation ---
    if (!Array.isArray(history)) {
      return res.status(400).json({ error: "History must be an array." });
    }

    let systemPrompt =
      "You are a helpful assistant for Punjab Ghar Ghar Rozgar and Karobar Mission (PGRKAM). Your role is to assist users with job searches, skill development, and career counseling.";

    if (userProfile?.skills) {
      systemPrompt += ` The user has the following skills: ${userProfile.skills}. Use this information to provide better recommendations.`;
    }

    const messages = [{ role: "system", content: systemPrompt }, ...history];

    const initialData = await callOpenAI(messages, tools);
    const message = initialData.choices?.[0]?.message;

    if (message?.tool_calls) {
      const toolCall = message.tool_calls[0];
      const functionName = toolCall.function.name;

      if (functionName === "get_jobs") {
        const args = JSON.parse(toolCall.function.arguments);
        const functionResult = await getJobsFromDatabase(args);

        const finalMessages = [
          ...messages,
          message,
          {
            tool_call_id: toolCall.id,
            role: "tool",
            name: functionName,
            content: functionResult,
          },
        ];

        const finalData = await callOpenAI(finalMessages);
        res.json({ reply: finalData.choices?.[0]?.message?.content || "No reply" });
      }
    } else {
      res.json({ reply: message?.content || "I'm not sure how to respond to that." });
    }
  } catch (err) {
    next(err); // Pass error to the centralized handler
  }
}