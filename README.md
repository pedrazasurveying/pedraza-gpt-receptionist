# Pedraza GPT Receptionist

## What this does
- Twilio GET /incoming-call -> returns TwiML that opens a bidirectional audio stream.
- Twilio streams audio to WS /media-stream.
- App forwards audio to OpenAI Realtime (gpt-4o-mini-realtime) and streams voice replies back.

## Local test (optional)
- cp .env.example .env
- npm install
- npm start
- ngrok http 7860
- In Twilio Number → "A CALL COMES IN" → Webhook → https://YOUR_NGROK/incoming-call

## Deploy on Render
- New Web Service from this repo
- Build: npm install
- Start: npm start
- Set env vars from .env.example
- After deploy, use: https://YOUR-RENDER/incoming-call in Twilio
