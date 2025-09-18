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

// Tiny health endpoints (handy while testing)
app.get("/", async (_req, reply) => reply.send("ok"));
app.get("/healthz", async (_req, reply) => reply.send("ok"));

/** Build TwiML that tells Twilio to open a bidirectional media stream */
function buildTwiML(host) {
  const wsUrl = `wss://${host}/media-stream`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
}

/** Twilio fetches TwiML here (GET or POST). We return <Connect><Stream> */
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

/** Twilio opens this WebSocket to stream the call audio */
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
  const queue = [];     // messages queued before AI socket opens
  const prebuffer = []; // caller audio collected before AI socket opens

  const sendAI = (obj) => {
    const data = JSON.stringify(obj);
    if (aiReady) ai.send(data);
    else queue.push(data);
  };

  ai.on("open", () => {
    aiReady = true;
    // Flush anything queued before the AI ws was ready
    for (const d of queue) ai.send(d);
    // Flush early caller audio
    if (prebuffer.length) {
      for (const f of prebuffer) ai.send(JSON.stringify(f));
      prebuffer.length = 0;
    }
  });

  // ---- Twilio -> OpenAI ----
  connection.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      // Configure session for phone audio + your prompt
      sendAI({
        type: "session.update",
        session: {
          instructions:
            (RECEPTIONIST_PROMPT && RECEPTIONIST_PROMPT.trim()) ||
            "You are Pedraza Surveying's receptionist. Be brief, friendly, and efficient.",
          modalities: ["audio"],
          voice: VOICE,
          input_audio_format:  { type: "pcmu", sample_rate_hz: 8000 },
          output_audio_format: { type: "pcmu", sample_rate_hz: 8000 },
          // server-side VAD so Elena pauses when caller talks
          turn_detection: { type: "server_vad", threshold: 0.5 },
        },
      });

      // Greet immediately even if caller is silent
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
        audio: msg.media.payload, // base64 μ-law @8k
        format: "pcmu",
      };
      if (aiReady) ai.send(JSON.stringify(frame));
      else prebuffer.push(frame);
      return;
    }

    if (msg.event === "stop") {
      sendAI({ type: "input_audio_buffer.commit" });
      try { ai.close(); } catch {}
      return;
    }
  });

  // ---- OpenAI -> Twilio ----
  ai.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Be tolerant to event name variants for audio chunks
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

    // End-of-utterance markers
    if (
      msg.type === "response.output_audio.done" ||
      msg.type === "output_audio.done" ||
      msg.type === "response.completed"
    ) {
      connection.send(JSON.stringify({ event: "mark", mark: { name: "done" } }));
      return;
    }

    // Pass through explicit commits if the model sends them
    if (msg.type === "input_audio_buffer.commit") {
      sendAI({ type: "input_audio_buffer.commit" });
    }
  });

  ai.on("close", () => { try { connection.close(); } catch {} });
  ai.on("error", () => { try { connection.close(); } catch {} });
  connection.on("close", () => { try { ai.close(); } catch {} });
});

app.listen({ port: PORT, host: "0.0.0.0" }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
