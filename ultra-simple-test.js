import fs from 'fs';
import { SpeechClient } from '@google-cloud/speech';

const client = new SpeechClient();
const filePath = './test.wav';

async function runSimpleTest() {
    console.log('--- Running Ultra-Simple Test ---');
    try {
        const file = fs.readFileSync(filePath);
        const audioBytes = file.toString('base64');

        const audio = { content: audioBytes };

        const config = {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000, // update to match your file
            languageCode: 'en-US',
            alternativeLanguageCodes: ['en-IN', 'hi-IN', 'pa-IN'],
            enableAutomaticPunctuation: true,
        };

        const request = { audio, config };

        console.log('Sending simplest possible request to Google...');
        const [response] = await client.recognize(request);

        const transcription = response.results
            .map(r => r.alternatives[0].transcript)
            .join('\n');

        console.log('✅✅✅ SUCCESS! THIS MEANS YOUR ENVIRONMENT IS WORKING!');
        console.log('Transcription:', transcription || 'No speech detected.');
    } catch (err) {
        console.error('❌❌❌ TEST FAILED. This points to a Google Cloud Project issue.');
        console.error(err.message || err);
    }
}

runSimpleTest();
