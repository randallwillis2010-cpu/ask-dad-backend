// server.js (Ask Dad + Dad Jokes + Homework Help w/ photo + ElevenLabs streaming)
// ✅ Uses OpenAI Responses API for image+text (vision)
// ✅ Returns full absolute ttsUrl
// ✅ Avoids JSON parse crash by always returning JSON errors

import "dotenv/config";
import express from "express";
import cors from "cors";
import { Readable } from "node:stream";

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));

/**
 * ENV needed on Render:
 * OPENAI_API_KEY
 * ELEVENLABS_API_KEY
 * ELEVENLABS_VOICE_ID
 *
 * Recommended on Render:
 * RENDER_EXTERNAL_URL = https://ask-dad-backend.onrender.com
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const PORT = process.env.PORT || 10000;
const BASE_URL =
  process.env.RENDER_EXTERNAL_URL?.replace(/\/+$/, "") ||
  `http://localhost:${PORT}`;

/* ---------------------------
   TTS Cache (short-lived)
----------------------------*/
const TTS_CACHE = new Map(); // id -> { payload: {text, mode}, expiresAt }
const TTS_TTL_MS = 10 * 60 * 1000;

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function cacheTtsPayload(payload) {
  const id = makeId();
  TTS_CACHE.set(id, { payload, expiresAt: Date.now() + TTS_TTL_MS });
  return id;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, v] of TTS_CACHE.entries()) {
    if (!v || v.expiresAt < now) TTS_CACHE.delete(id);
  }
}, 60_000);

/* ---------------------------
   Basic routes
----------------------------*/
app.get("/", (req, res) => res.send("✅ Ask Dad backend alive"));
app.get("/health", (req, res) => res.json({ ok: true }));

/* ---------------------------
   Prompts
----------------------------*/
function modeSystemPrompt(mode) {
  switch (mode) {
    case "homework":
      return `You are "Homework Dad": a kind, patient tutor. Teach, don’t just answer.
Rules:
- Explain step-by-step clearly.
- For math/science: show steps, formulas, and reasoning.
- For writing: help outline, improve, and give examples.
- If the question/photo is unclear, ask ONE short clarifying question.
- Keep it friendly and encouraging.`;

    case "coach":
      return `You are "Dad Coach": upbeat, direct, motivating, short steps, confidence-building. No fluff.`;
    case "soft":
      return `You are "Soft Dad": warm, reassuring, patient, gentle humor, helps regulate emotions, small steps.`;
    case "tough":
      return `You are "No-Nonsense Dad": practical, blunt (not rude), safety-first, step-by-step, checks for tools/materials.`;
    case "funny":
      return `You are "Goofy Dad": playful, corny jokes sprinkled in, still helpful and step-by-step.`;
    case "dadjokes":
      return `You only tell ONE original dad joke per request. Must be new, not a known classic. Short. Family-friendly.`;
    default:
      return `You are "Ask Dad": supportive, practical, step-by-step, warm and slightly funny.`;
  }
}

/* ---------------------------
   OpenAI helpers
   - /ask-dad uses chat/completions (text-only)
   - /homework-help uses responses API (image+text)
----------------------------*/
function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function isRepeatedJoke(joke, history = []) {
  const j = normalize(joke);
  return history.some((h) => normalize(h) === j);
}

async function callOpenAIChat({ messages, temperature = 0.85, model = "gpt-4.1-mini" }) {
  if (!OPENAI_API_KEY) {
    return { ok: false, text: "Missing OPENAI_API_KEY on backend." };
  }

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, temperature, messages }),
  });

  if (!r.ok) {
    const t = await r.text();
    console.log("OpenAI chat error:", r.status, t);
    return { ok: false, text: "Dad brain is busy right now. Try again in a minute." };
  }

  const json = await r.json();
  const text = json?.choices?.[0]?.message?.content?.trim();
  return { ok: true, text: text || "…Dad blanked. Try again." };
}

async function callOpenAIResponses({ input, model = "gpt-4.1-mini", temperature = 0.7 }) {
  if (!OPENAI_API_KEY) {
    return { ok: false, text: "Missing OPENAI_API_KEY on backend." };
  }

  // Responses API supports multimodal content
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature,
      input,
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    console.log("OpenAI responses error:", r.status, t);
    return { ok: false, text: "Homework Dad is busy right now. Try again in a minute." };
  }

  const json = await r.json();

  // Pull text from output safely
  const out = json?.output || [];
  let text = "";
  for (const item of out) {
    const content = item?.content || [];
    for (const c of content) {
      if (c?.type === "output_text" && c?.text) {
        text += c.text;
      }
    }
  }

  text = String(text || "").trim();
  return { ok: true, text: text || "I couldn’t read that clearly—try a brighter, closer photo." };
}

async function getDadAnswer({ question, mode = "default", jokeHistory = [] }) {
  const system = modeSystemPrompt(mode);

  if (mode === "dadjokes") {
    const antiRepeat =
      jokeHistory?.length
        ? `Avoid repeating any of these recent jokes (even if reworded):\n- ${jokeHistory
            .slice(-25)
            .join("\n- ")}`
        : "";

    const baseMessages = [
      { role: "system", content: system },
      ...(antiRepeat ? [{ role: "system", content: antiRepeat }] : []),
      {
        role: "user",
        content:
          `Create ONE brand-new dad joke.\n` +
          `Rules:\n` +
          `- Not a famous classic.\n` +
          `- Different topic/setup/punchline than the recent list.\n` +
          `- One-liner or two short lines max.\n` +
          `- No preface like "Sure!"\n` +
          `- No quotes.\n` +
          `- Family-friendly.\n`,
      },
    ];

    for (let attempt = 1; attempt <= 4; attempt++) {
      const r = await callOpenAIChat({ messages: baseMessages, temperature: 1.15 });
      const joke = (r.text || "").trim() || "My joke drawer glitched… hit me again 😄";
      if (!isRepeatedJoke(joke, jokeHistory)) return joke;

      baseMessages.push({
        role: "system",
        content: "Too similar. Generate a completely different new joke with a different topic.",
      });
    }

    return "Alright kiddo… my joke drawer’s stuck. Try again 😅";
  }

  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        `Question: ${question}\n\n` +
        `Answer like Dad:\n` +
        `- 1 short warm opener\n` +
        `- then numbered steps\n` +
        `- then 1 encouraging line\n` +
        `- keep it concise\n`,
    },
  ];

  const r = await callOpenAIChat({ messages, temperature: 0.85 });
  return r.text;
}

async function getHomeworkHelp({ question = "", imageBase64 = "" }) {
  const q = String(question || "").trim();
  const hasImage = !!imageBase64;

  const system = modeSystemPrompt("homework");

  const content = [
    {
      type: "input_text",
      text:
        system +
        "\n\n" +
        (q ? `Student question: ${q}\n\n` : "") +
        "If there’s a problem in the photo, solve it step-by-step and teach the method. " +
        "If the student can copy answers, still teach the method first.",
    },
  ];

  if (hasImage) {
    content.push({
      type: "input_image",
      image_url: `data:image/jpeg;base64,${imageBase64}`,
    });
  }

  const r = await callOpenAIResponses({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    input: [
      {
        role: "user",
        content,
      },
    ],
  });

  return (r.text || "").trim() || "I couldn’t read that clearly—try a closer photo with better lighting.";
}

/* ---------------------------
   ElevenLabs TTS (streaming)
----------------------------*/
function voiceSettingsForMode(mode) {
  switch (mode) {
    case "coach":
      return { stability: 0.26, similarity_boost: 0.90, style: 0.62, use_speaker_boost: true };
    case "soft":
      return { stability: 0.34, similarity_boost: 0.92, style: 0.42, use_speaker_boost: true };
    case "tough":
      return { stability: 0.42, similarity_boost: 0.90, style: 0.28, use_speaker_boost: true };
    case "funny":
      return { stability: 0.22, similarity_boost: 0.88, style: 0.74, use_speaker_boost: true };
    case "dadjokes":
      return { stability: 0.20, similarity_boost: 0.86, style: 0.80, use_speaker_boost: true };
    case "homework":
      return { stability: 0.32, similarity_boost: 0.92, style: 0.40, use_speaker_boost: true };
    default:
      return { stability: 0.28, similarity_boost: 0.90, style: 0.55, use_speaker_boost: true };
  }
}

function humanCadenceText(input) {
  let t = String(input || "").trim();
  t = t.replace(/\r/g, "").replace(/[ \t]{2,}/g, " ");
  t = t.replace(/\n{2,}/g, "\n").replace(/\n/g, ". ");

  t = t
    .replace(/\b1[\)\.\:]\s*/g, "First: ")
    .replace(/\b2[\)\.\:]\s*/g, "Next: ")
    .replace(/\b3[\)\.\:]\s*/g, "Then: ")
    .replace(/\b4[\)\.\:]\s*/g, "After that: ")
    .replace(/\b5[\)\.\:]\s*/g, "Finally: ");

  t = t.replace(/([.!?])\s+/g, "$1 ... ");
  t = t.replace(/,\s+/g, ", ... ");
  if (t.length > 1800) t = t.slice(0, 1800);
  return t.trim();
}

async function streamElevenLabsTTS(res, text, mode = "default") {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    res.status(500).json({
      error: "Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID.",
    });
    return;
  }

  const dadText = humanCadenceText(text);
  const settings = voiceSettingsForMode(mode);

  const elevenUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`;

  let tts;
  try {
    tts = await fetch(elevenUrl, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: dadText,
        model_id: "eleven_turbo_v2_5",
        optimize_streaming_latency: 3,
        voice_settings: settings,
      }),
    });
  } catch (e) {
    console.log("ElevenLabs fetch failed:", e);
    res.status(500).json({ error: "ElevenLabs request failed" });
    return;
  }

  if (!tts.ok) {
    const errText = await tts.text();
    console.log("ElevenLabs error:", tts.status, errText);
    res.status(500).json({ error: "ElevenLabs TTS failed" });
    return;
  }

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    const nodeStream = Readable.fromWeb(tts.body);
    nodeStream.on("error", (err) => {
      console.log("TTS stream error:", err);
      try { res.end(); } catch {}
    });
    nodeStream.pipe(res);
  } catch (e) {
    console.log("Readable.fromWeb failed:", e);
    res.status(500).json({ error: "Streaming conversion failed" });
  }
}

/* ---------------------------
   Endpoints
----------------------------*/
app.post("/ask-dad", async (req, res) => {
  try {
    const { question, mode = "default", jokeHistory = [] } = req.body || {};
    const answer = await getDadAnswer({ question, mode, jokeHistory });

    const ttsId = cacheTtsPayload({ text: answer, mode });
    return res.json({
      answer,
      ttsUrl: `${BASE_URL}/tts-stream/${ttsId}`,
    });
  } catch (e) {
    console.log("❌ /ask-dad crashed:", e);
    res.status(500).json({ error: "Server crashed" });
  }
});

app.post("/homework-help", async (req, res) => {
  try {
    const { question = "", imageBase64 = "" } = req.body || {};

    if (imageBase64 && imageBase64.length > 7_000_000) {
      return res.status(400).json({
        error: "Image too large. Try a closer photo of just the problem.",
      });
    }

    const answer = await getHomeworkHelp({ question, imageBase64 });

    const ttsId = cacheTtsPayload({ text: answer, mode: "homework" });
    return res.json({
      answer,
      ttsUrl: `${BASE_URL}/tts-stream/${ttsId}`,
    });
  } catch (e) {
    console.log("❌ /homework-help crashed:", e);
    res.status(500).json({ error: "Homework help crashed" });
  }
});

app.get("/tts-stream/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const entry = TTS_CACHE.get(id);
    if (!entry) return res.status(404).send("TTS expired or not found.");

    const payload = entry.payload || {};
    return streamElevenLabsTTS(res, payload.text || "", payload.mode || "default");
  } catch (e) {
    console.log("❌ /tts-stream crashed:", e);
    res.status(500).json({ error: "TTS stream crashed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Ask Dad backend running");
  console.log("✅ Port:", PORT);
  console.log("✅ Base URL:", BASE_URL);
});
