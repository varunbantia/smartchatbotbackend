// src/config/gcpConfig.js
import admin from "firebase-admin";
import speech from "@google-cloud/speech";
import dotenv from "dotenv";

dotenv.config();

let serviceAccount = {};
try {
  // Parse service account from environment variable
  serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "{}");

  // The private_key from env vars needs its line breaks restored
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
} catch (err) {
  console.error("❌ Failed to parse Google Cloud service account JSON:", err);
}

// Initialize Firebase Admin SDK if not already done
if (!admin.apps.length && serviceAccount.project_id) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("✅ Firebase Admin SDK initialized.");
}

// Export Firestore and Speech Client instances
export const db = admin.firestore();
export const speechClient = new speech.SpeechClient({
  projectId: serviceAccount.project_id,
  credentials: {
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key,
  },
});