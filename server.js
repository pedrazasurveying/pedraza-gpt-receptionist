// Minimal Twilio <-> OpenAI Realtime bridge (PCMU, 8kHz) for PEDRAZA SURVEYING
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

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = Fastify({ logger: true });
await app.register(websocket);

// 1) Twilio fetches TwiML here. We tell it to open a bidirectional stream to /media-stream
app.get("/incoming-call", async (req, reply) => {
  if (STREAM_SECRET && req.headers["x-pedraza-secret"] !== STREAM_SECRET) {
    reply.code(403).send("Forbidden");
    return;
  }
  const wsUrl = `wss://${req.headers.host}/media-stream`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
  reply.header("Content-Type", "text/xml").send(twiml);
});

// 2) Twilio opens this WebSocket to stream the call audio
app.get("/media-stream", { websocket: true }, (connection, req) => {
  if (STREAM_SECRET && req.headers["x-pedraza-secret"] !== STREAM_SECRET) {
    connection.close();
    return;
  }

  // OpenAI Realtime WS (format=pcmu for G.711 μ-law at 8kHz)
  const ai = new WS(
    `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}&voice=${VOICE}&format=pcmu`,
    {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  // Twilio -> OpenAI
  connection.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "media" && msg.media?.payload) {
        ai.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,   // base64 μ-law
          format: "pcmu"
        }));
      }

      if (msg.event === "start") {
        // Receptionist instructions for PEDRAZA SURVEYING
        ai.send(JSON.stringify({
          type: "session.update",
          session: {
            instructions:
              "You are Pedraza Surveying's receptionist. Be brief, friendly, and efficient. " +
              "Collect: caller name, callback number, property address or Quick Ref ID, survey type (ALTA, boundary, topo, elevation cert, etc.), and desired timeline. " +
              "Offer to text our intake link on request. If the matter seems urgent/unclear, offer transfer to a human. " +
              "Speak clearly, one idea per sentence, and pause for the caller.",
            turn_detection: { type: "server_vad", threshold: 0.5 }
          }
        }));

        // Greeting to start the conversation
        ai.send(JSON.stringify({
          type: "response.create",
          response: { instructions: "Hi, thanks for calling Pedraza Surveying, also known as Tejas Surveying. I'm Elena, how can I help you today?" }
        }));
      }

      if (msg.event === "stop") {
        ai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        try { ai.close(); } catch {}
      }
    } catch { /* ignore non-JSON frames */ }
  });

  // OpenAI -> Twilio
  ai.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "output_audio.delta" && msg.audio) {
        connection.send(JSON.stringify({ event: "media", media: { payload: msg.audio } }));
      }
      if (msg.type === "output_audio.done") {
        connection.send(JSON.stringify({ event: "mark", mark: { name: "done" } }));
      }
    } catch { /* ignore */ }
  });

  ai.on("close", () => { try { connection.close(); } catch {} });
  ai.on("error", () => { try { connection.close(); } catch {} });
  connection.on("close", () => { try { ai.close(); } catch {} });
});

app.listen({ port: PORT, host: "0.0.0.0" }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
