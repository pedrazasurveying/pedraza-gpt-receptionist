// Twilio <-> OpenAI Realtime bridge (PCMU, 8kHz) for PEDRAZA SURVEYING
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import dotenv from "dotenv";
import { WebSocket as WS } from "ws";

dotenv.config();

const PORT = process.env.PORT || 7860;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini-realtime";
const VOICE = process.env.VOICE || "alloy";
const STREAM_SECRET = process.env.STREAM_SECRET; // optional shared-secret header
const RECEPTIONIST_PROMPT = process.env.RECEPTIONIST_PROMPT || "";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = Fastify({ logger: true });
await app.register(websocket);

/** Utility: build TwiML that tells Twilio to open a bidirectional media stream */
function buildTwiML(host) {
  const wsUrl = `wss://${host}/media-stream`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
}

/** 1) Twilio fetches TwiML here (GET or POST). We return <Connect><Stream> */
async function incomingCallHandler(req, reply) {
  if (STREAM_SECRET && req.headers["x-pedraza-secret"] !== STREAM_SECRET) {
    reply.code(403).send("Forbidden");
    return;
  }
  const twiml = buildTwiML(req.headers.host);
  reply.header("Content-Type", "text/xml").send(twiml);
}
app.get("/incoming-call", incomingCallHandler);
app.post("/incoming-call", incomingCallHandler);

/** 2) Twilio opens this WebSocket to stream the call audio */
app.get("/media-stream", { websocket: true }, (connection, req) => {
  if (STREAM_SECRET && req.headers["x-pedraza-secret"] !== STREAM_SECRET) {
    connection.close();
    return;
  }

  // --- OpenAI Realtime WS (μ-law, 8kHz) ---
  const ai = new WS(
    `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}&voice=${VOICE}&format=pcmu`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let aiReady = false;
  const queue = [];        // queue for messages to AI before socket is OPEN
  const prebuffer = [];    // optional small buffer for early caller audio

  const sendAI = (obj) => {
    const data = JSON.stringify(obj);
    if (aiReady) {
      ai.send(data);
    } else {
      queue.push(data);
    }
  };

  ai.on("open", () => {
    aiReady = true;
    // Flush anything we queued before the AI socket was open
    for (const d of queue) ai.send(d);
  });

  // ---- Twilio -> OpenAI ----
  connection.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      // Configure the session for phone audio + your prompt
      sendAI({
        type: "session.update",
        session: {
          // Your long script goes here if provided as env var; else short fallback:
          instructions:
            (RECEPTIONIST_PROMPT && RECEPTIONIST_PROMPT.trim()) ||
            "You are Pedraza Surveying's receptionist. Be brief, friendly, and efficient.",
          modalities: ["audio"],
          voice: VOICE,
          // Be explicit about formats so Twilio<->OpenAI align:
          input_audio_format: { type: "pcmu", sample_rate_hz: 8000 },
          output_audio_format: { type: "pcmu", sample_rate_hz: 8000 },
          // Turn detection lets Elena stop when caller barges in
          turn_detection: { type: "server_vad", threshold: 0.5 },
        },
      });

      // Greet immediately even if the caller is silent
      sendAI({
        type: "response.create",
        response: {
          instructions:
            "Hi. Thank you for calling Pedraza Surveying, also known as Tejas Surveying. This is Elena, how can I help you today?",
        },
      });
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      const frame = {
        type: "input_audio_buffer.append",
        audio: msg.media.payload, // base64 μ-law (8k)
        format: "pcmu",
      };
      if (aiReady) {
        ai.send(JSON.stringify(frame));
      } else {
        // Buffer early audio until AI socket is ready
        prebuffer.push(frame);
      }
      return;
    }

    if (msg.event === "stop") {
      // Commit any buffered audio and close
      sendAI({ type: "input_audio_buffer.commit" });
      try { ai.close(); } catch {}
      return;
    }
  });

  // Once AI is ready, flush any early caller audio we buffered
  ai.on("open", () => {
    if (prebuffer.length) {
      for (const f of prebuffer) ai.send(JSON.stringify(f));
      prebuffer.length = 0;
    }
  });

  // ---- OpenAI -> Twilio ----
  ai.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Different SDKs/schemas use different keys for audio deltas—cover them all
    const b64 =
      (msg.type === "response.output_audio.delta" && msg.delta) ||
      (msg.type === "response.audio.delta" && msg.delta) ||
      (msg.type === "output_audio.delta" && msg.audio) ||
      null;

    if (b64) {
      connection.send(
        JSON.stringify({ event: "media", media: { payload: b64 } })
      );
      return;
    }

    // End-of-utterance markers (optional)
    if (
      msg.type === "response.output_audio.done" ||
      msg.type === "output_audio.done" ||
      msg.type === "response.completed"
    ) {
      connection.send(JSON.stringify({ event: "mark", mark: { name: "done" } }));
      return;
    }

    // If the model asks us to flush input audio explicitly
    if (msg.type === "input_audio_buffer.commit") {
      sendAI({ type: "input_audio_buffer.commit" });
    }
  });

  ai.on("close",
