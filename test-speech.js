import fs from 'fs';
import { SpeechClient } from '@google-cloud/speech';

// 1. Create the client
const client = new SpeechClient({ apiVersion: 'v1p1beta1' });

// 2. IMPORTANT: Change this to the actual path of your test audio file
const filePath = './test-audio.3gp'; 

async function runTest() {
    console.log('Running test script...');
    try {
        // 3. Read the file and prepare the request
        const file = fs.readFileSync(filePath);
        const audioBytes = file.toString('base64');

        const audio = {
            content: audioBytes,
        };
        const config = {
            encoding: 'AMR',
            sampleRateHertz: 8000,
            languageCodes: ['en-IN', 'hi-IN', 'pa-IN'],
            enableAutomaticPunctuation: true,
        };
        const request = {
            audio: audio,
            config: config,
        };

        // 4. Call the API
        console.log('Sending request to Google Cloud STT...');
        const [response] = await client.recognize(request);

        const transcription = response.results
            .map(result => result.alternatives[0].transcript)
            .join('\n');

        console.log('✅ SUCCESS! Transcription:', transcription);
        console.log('Detected language:', response.results[0]?.languageCode);

    } catch (err) {
        console.error('❌ TEST FAILED:', err);
    }
}

runTest();