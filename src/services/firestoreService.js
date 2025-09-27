// src/services/firestoreService.js
import { db } from "../config/gcpConfig.js";

/**
 * Fetches jobs from Firestore based on location and keywords.
 * @param {object} params - The query parameters.
 * @param {string} [params.location] - The job location.
 * @param {string} [params.keyword] - Comma-separated skills/keywords.
 * @returns {Promise<string>} A JSON string of the jobs array.
 */
export async function getJobsFromDatabase({ location, keyword }) {
  console.log(`🔎 Querying Firestore for jobs. Location: ${location}, Keyword: ${keyword}`);
  try {
    let query = db.collection("jobs");

    if (location) {
      query = query.where("location", "==", location);
    }

    // Firestore's array-contains-any has a limit of 10 values in the array
    if (keyword) {
      const keywords = keyword.toLowerCase().split(/, |,/);
      query = query.where("requiredSkills", "array-contains-any", keywords);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      return JSON.stringify([]);
    }

    const jobs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return JSON.stringify(jobs);
  } catch (error) {
    console.error("🔥 Firestore error:", error);
    // Avoid leaking implementation details in the error response
    return JSON.stringify({ error: "An error occurred while fetching jobs." });
  }
}