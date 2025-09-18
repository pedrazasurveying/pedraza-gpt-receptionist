// Twilio <-> OpenAI Realtime bridge (PCMU, 8kHz) for PEDRAZA SURVEYING
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import dotenv from "dotenv";
import { WebSocket as WS } from "ws";
import fs from "fs";
import formbody from "@fastify/formbody";

dotenv.config();

const PORT = process.env.PORT || 7860;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini-realtime";
const VOICE = process.env.VOICE || "alloy";
const STREAM_SECRET = process.env.STREAM_SECRET; // optional shared-secret

// Prompts/KB
const RECEPTIONIST_PROMPT = (process.env.RECEPTIONIST_PROMPT || "").trim();
const KB_TEXT = (process.env.KB_TEXT || "").trim();
const KB_FILE = fs.existsSync("./kb.md")  ? fs.readFileSync("./kb.md",  "utf8") : "";
const FAQ_FILE = fs.existsSync("./faq.md") ? fs.readFileSync("./faq.md", "utf8") : "";
const SOP_FILE = fs.existsSync("./sop.md") ? fs.readFileSync("./sop.md", "utf8") : "";

function buildKB() {
  let parts = [];
  if (KB_TEXT) parts.push(KB_TEXT);
  if (KB_FILE) parts.push(`\n# KB\n${KB_FILE}`);
  if (FAQ_FILE) parts.push(`\n# FAQ\n${FAQ_FILE}`);
  if (SOP_FILE) parts.push(`\n# SOP\n${SOP_FILE}`);
  const joined = parts.join("\n\n").trim();
  return joined.slice(0, 60000); // cap for snappy first turn
}

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = Fastify({ logger: true });

// WebSocket plugin (echo Twilio's "audio" subprotocol)
await app.register(websocket, {
  options: {
    handleProtocols: (protocols /*, request*/) => {
      if (Array.isArray(protocols) && protocols.includes("audio")) return "audio";
      return protocols && protocols.length ? false : undefined;
    },
  },
});

// Parse Twilio POST bodies (x-www-form-urlencoded) so we don’t 415
await app.register(formbody);

// Health
app.get("/", async (_req, reply) => reply.send("ok"));
app.get("/healthz", async (_req, reply) => reply.send("ok"));

/** TwiML builder — bidirectional audio */
function twiml(host) {
  const wsUrl = `wss://${host}/media-stream`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" track="both_tracks" />
  </Connect>
</Response>`;
}

/** Twilio fetches TwiML here (GET or POST). */
async function incomingCall(req, reply) {
  if (STREAM_SECRET && req.headers["x-pedraza-secret"] !== STREAM_SECRET) {
    reply.code(403).send("Forbidden");
    return;
  }
  reply.header("Content-Type", "text/xml").send(twiml(req.headers.host));
}
app.get("/incoming-call", incomingCall);
app.post("/incoming-call", incomingCall);

/** Media stream: Twilio opens WS here */
app.get("/media-stream", { websocket: true }, (connection, req) => {
  if (STREAM_SECRET && req.headers["x-pedraza-secret"] !== STREAM_SECRET) {
    connection.close();
    return;
  }

  const ai = new WS(
    `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}&voice=${VOICE}&format=pcmu`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  let aiReady = false;
  const queue = [];
  const prebuffer = [];
  let textBuf = "";
  let streamSid = null; // Twilio stream ID (required for outbound)
  let outCount = 0;

  const sendAI = (obj) => {
    const data = JSON.stringify(obj);
    if (aiReady) ai.send(data); else queue.push(data);
  };

  ai.on("open", () => {
    aiReady = true;
    for (const d of queue) ai.send(d);
    if (prebuffer.length) {
      for (const f of prebuffer) ai.send(JSON.stringify(f));
      prebuffer.length = 0;
    }
  });

  // ---- Twilio -> OpenAI ----
  connection.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || msg.streamSid || null;
      app.log.info({ streamSid }, "Twilio stream started");

      const base = RECEPTIONIST_PROMPT || "You are Pedraza Surveying's receptionist. Be brief, friendly, efficient.";
      const kb = buildKB();
      const instructions = kb
        ? `${base}\n\n---\nKNOWLEDGE BASE (authoritative; if missing/uncertain, take a message — do not guess):\n${kb}\n---`
        : base;

      sendAI({
        type: "session.update",
        session: {
          instructions,
          modalities: ["audio", "text"],      // audio for caller, text for tag logging
          voice: VOICE,
          input_audio_format:  { type: "pcmu", sample_rate_hz: 8000 },
          output_audio_format: { type: "pcmu", sample_rate_hz: 8000 },
          turn_detection: { type: "server_vad", threshold: 0.5 },
        },
      });

      // Greet immediately even if caller is silent
      sendAI({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions:
            "Hi. Thank you for calling Pedraza Surveying, also known as Tejas Surveying. This is Elena, how can I help you today?",
        },
      });
      return;
    }

    if (msg.event === "connected") {
      app.log.info("Twilio WS connected");
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      const frame = { type: "input_audio_buffer.append", audio: msg.media.payload, format: "pcmu" };
      if (aiReady) ai.send(JSON.stringify(frame)); else prebuffer.push(frame);
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
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }

    // AUDIO chunks (tolerate schema variants)
    const b64 =
      (msg.type === "response.output_audio.delta" && msg.delta) ||
      (msg.type === "response.audio.delta" && msg.delta) ||
      (msg.type === "output_audio.delta" && msg.audio) || null;

    if (b64 && streamSid) {
      outCount++;
      if (outCount % 10 === 0) app.log.info({ outCount }, "sent outbound audio");
      connection.send(JSON.stringify({
        event: "media",
        streamSid,
        track: "outbound",   // REQUIRED for bidirectional
        media: { payload: b64 }
      }));
      return;
    }

    // TEXT deltas (for route tag logging)
    const textDelta =
      (msg.type === "response.output_text.delta" && msg.delta) ||
      (msg.type === "response.text.delta" && msg.delta) ||
      (msg.type === "output_text.delta" && msg.delta) || null;
    if (textDelta) {
      textBuf += textDelta;
      return;
    }

    // Utterance end
    if (
      msg.type === "response.output_audio.done" ||
      msg.type === "output_audio.done" ||
      msg.type === "response.completed"
    ) {
      if (streamSid) {
        connection.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "done" } }));
      }
      // Detect and log routing tag (not spoken)
      const m = textBuf.match(/\[\[ROUTE:(CINDY|BRENDA|JAY|JOSE|TAKE_MESSAGE|END)\]\]/i);
      if (m) app.log.info({ route_tag: m[0] }, "Elena route tag");
      textBuf = "";
      return;
    }

    // Pass-through commits if model requests
    if (msg.type === "input_audio_buffer.commit") {
      sendAI({ type: "input_audio_buffer.commit" });
    }
  });

  ai.on("close",  () => { try { connection.close(); } catch {} });
  ai.on("error",  (err) => { app.log.error(err, "AI socket error"); try { connection.close(); } catch {} });
  connection.on("error", (err) => { app.log.error(err, "Twilio WS error"); });
  connection.on("close", () => { try { ai.close(); } catch {} });
});

app.listen({ port: PORT, host: "0.0.0.0" }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
