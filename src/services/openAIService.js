// src/services/openAIService.js
import fetch from "node-fetch";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Calls the OpenAI API with a given set of messages and tools.
 * @param {Array<object>} messages - The conversation history.
 * @param {Array<object>} tools - The tools the model can use.
 * @returns {Promise<object>} The response data from OpenAI.
 */
export async function callOpenAI(messages, tools = []) {
  const body = {
    model: "gpt-3.5-turbo",
    messages,
  };

  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errorBody}`);
  }

  return response.json();
}