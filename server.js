// Twilio <-> OpenAI Realtime bridge (PCMU, 8kHz) for PEDRAZA SURVEYING
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import dotenv from "dotenv";
import { WebSocket as WS } from "ws";
import fs from "fs";

dotenv.config();

const PORT = process.env.PORT || 7860;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini-realtime";
const VOICE = process.env.VOICE || "alloy";
const STREAM_SECRET = process.env.STREAM_SECRET; // optional shared-secret header

// Prompts/KB sources
const RECEPTIONIST_PROMPT = (process.env.RECEPTIONIST_PROMPT || "").trim();
const KB_TEXT = (process.env.KB_TEXT || "").trim();
const KB_FILE = fs.existsSync("./kb.md")  ? fs.readFileSync("./kb.md",  "utf8") : "";
const FAQ_FILE = fs.existsSync("./faq.md") ? fs.readFileSync("./faq.md", "utf8") : "";
const SOP_FILE = fs.existsSync("./sop.md") ? fs.readFileSync("./sop.md", "utf8") : "";

// Assemble a single KB blob (trim to avoid huge payloads)
function buildKB() {
  let parts = [];
  if (KB_TEXT) parts.push(KB_TEXT);
  if (KB_FILE) parts.push(`\n# KB\n${KB_FILE}`);
  if (FAQ_FILE) parts.push(`\n# FAQ\n${FAQ_FILE}`);
  if (SOP_FILE) parts.push(`\n# SOP\n${SOP_FILE}`);
  const joined = parts.join("\n\n").trim();
  // hard cap ~60k chars to keep the first turn fast (tune as needed)
  return joined.slice(0, 60000);
}

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = Fastify({ logger: true });
await app.register(websocket);

// Health
app.get("/", async (_req, reply) => reply.send("ok"));
app.get("/healthz", async (_req, reply) => reply.send("ok"));

function twiml(host) {
  const wsUrl = `wss://${host}/media-stream`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Connect><Stream url="${wsUrl}"/></Connect></Response>`;
}

async function incomingCall(req, reply) {
  if (STREAM_SECRET && req.headers["x-pedraza-secret"] !== STREAM_SECRET) {
    reply.code(403).send("Forbidden");
    return;
  }
  reply.header("Content-Type", "text/xml").send(twiml(req.headers.host));
}
app.get("/incoming-call", incomingCall);
app.post("/incoming-call", incomingCall);

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
  let textBuf = ""; // capture text output for tags/logging

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

  connection.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      const base = RECEPTIONIST_PROMPT || "You are Pedraza Surveying's receptionist. Be brief, friendly, efficient.";
      const kb = buildKB();
      const instructions = kb
        ? `${base}\n\n---\nKNOWLEDGE BASE (authoritative; if missing/uncertain, take a message — do not guess):\n${kb}\n---`
        : base;

      sendAI({
        type: "session.update",
        session: {
          instructions,
          modalities: ["audio", "text"], // get text too for logging/tags
          voice: VOICE,
          input_audio_format:  { type: "pcmu", sample_rate_hz: 8000 },
          output_audio_format: { type: "pcmu", sample_rate_hz: 8000 },
          turn_detection: { type: "server_vad", threshold: 0.5 },
        },
      });

      // Greet immediately (even if caller is silent)
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

  ai.on("message", (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }

    // AUDIO back to Twilio (tolerate schema variants)
    const b64 =
      (msg.type === "response.output_audio.delta" && msg.delta) ||
      (msg.type === "response.audio.delta" && msg.delta) ||
      (msg.type === "output_audio.delta" && msg.audio) || null;
    if (b64) {
      connection.send(JSON.stringify({ event: "media", media: { payload: b64 } }));
      return;
    }

    // TEXT accumulation (for tags/transcripts)
    const textDelta =
      (msg.type === "response.output_text.delta" && msg.delta) ||
      (msg.type === "response.text.delta" && msg.delta) ||
      (msg.type === "output_text.delta" && msg.delta) || null;
    if (textDelta) {
      textBuf += textDelta;
      return;
    }

    // Utterance end
    if (msg.type === "response.output_audio.done" || msg.type === "output_audio.done" || msg.type === "response.completed") {
      connection.send(JSON.stringify({ event: "mark", mark: { name: "done" } }));
      // Basic tag detection (logs only for now)
      const m = textBuf.match(/\[\[ROUTE:(CINDY|BRENDA|JAY|JOSE|TAKE_MESSAGE|END)\]\]/i);
      if (m) app.log.info({ route_tag: m[0] }, "Elena route tag");
      return;
    }
  });

  ai.on("close",  () => { try { connection.close(); } catch {} });
  ai.on("error",  () => { try { connection.close(); } catch {} });
  connection.on("close", () => { try { ai.close(); } catch {} });
});

app.listen({ port: PORT, host: "0.0.0.0" }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
