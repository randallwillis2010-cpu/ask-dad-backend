// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { Readable } from "node:stream";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/**
 * ENV needed on Render:
 * OPENAI_API_KEY
 * ELEVENLABS_API_KEY
 * ELEVENLABS_VOICE_ID
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

/* ---------------------------
   Simple in-memory TTS cache
----------------------------*/
const TTS_CACHE = new Map(); // id -> { text, expiresAt }
const TTS_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
   Routes
----------------------------*/
app.get("/", (req, res) => res.send("✅ Ask Dad backend alive"));
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/debug-env", (req, res) => {
  res.json({
    hasOpenAI: !!process.env.OPENAI_API_KEY,
    hasElevenKey: !!process.env.ELEVENLABS_API_KEY,
    hasElevenVoice: !!process.env.ELEVENLABS_VOICE_ID,
    node: process.version,
  });
});

/* ---------------------------
   MODE PROMPTS
----------------------------*/
function modeSystemPrompt(mode) {
  switch (mode) {
    case "coach":
      return `You are "Dad Coach": upbeat, direct, motivating, short steps, confidence-building. No fluff.`;
    case "soft":
      return `You are "Soft Dad": warm, reassuring, patient, gentle humor, helps regulate emotions, small steps.`;
    case "tough":
      return `You are "No-Nonsense Dad": practical, blunt (not rude), safety-first, step-by-step, checks for tools/materials.`;
    case "funny":
      return `You are "Goofy Dad": playful, corny jokes sprinkled in, still helpful and step-by-step.`;
    case "dadjokes":
      return `You only tell ONE original dad joke per request. Must be new, not a classic from a known list. Short.`;
    default:
      return `You are "Ask Dad": supportive, practical, step-by-step, warm and slightly funny.`;
  }
}

/* ---------------------------
   OpenAI helpers
----------------------------*/
function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

function isRepeatedJoke(joke, history = []) {
  const j = normalize(joke);
  return history.some((h) => normalize(h) === j);
}

async function callOpenAI(messages, temperature = 0.8) {
  if (!OPENAI_API_KEY) {
    return {
      ok: false,
      text: "Backend missing OPENAI_API_KEY. Add it in Render → Environment.",
    };
  }

  const body = {
    model: "gpt-4.1-mini",
    temperature,
    messages,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text();
    console.log("OpenAI error:", r.status, t);
    return { ok: false, text: "Dad brain is busy right now. Try again in a minute." };
  }

  const json = await r.json();
  const text = json?.choices?.[0]?.message?.content?.trim();
  return { ok: true, text: text || "…Dad blanked. Try again." };
}

async function getDadAnswer({ question, mode = "default", jokeHistory = [] }) {
  const system = modeSystemPrompt(mode);

  if (mode === "dadjokes") {
    const antiRepeat =
      jokeHistory?.length
        ? `Avoid repeating any of these recent jokes:\n- ${jokeHistory
            .slice(-15)
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
          `- One-liner or two short lines max.\n` +
          `- No preface like "Sure!"\n` +
          `- No quotes.\n`,
      },
    ];

    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await callOpenAI(baseMessages, 1.1);
      const joke = r.text || "I tried to tell a joke… but it needed a restart. 😄";
      if (!isRepeatedJoke(joke, jokeHistory)) return joke;

      baseMessages.push({
        role: "system",
        content: `Your last joke matched the recent list. Generate a completely different one with a different setup/punchline.`,
      });
    }

    return "I’d tell you a new one… but my joke drawer’s stuck. Try again 😅";
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

  const r = await callOpenAI(messages, 0.8);
  return r.text;
}

/* ---------------------------
   HUMAN CADENCE (TTS text cleanup)
   Goal: sound less robotic + faster streaming
----------------------------*/
function humanCadenceText(input) {
  let t = String(input || "");

  // remove emojis (TTS reads them weird)
  t = t.replace(
    /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD00-\uDFFF])/g,
    ""
  );

  // normalize whitespace/newlines
  t = t.replace(/\r/g, "").replace(/\n{2,}/g, "\n").trim();

  // make numbered steps clearer
  // "1." -> "Step 1:"
  t = t.replace(/(^|\n)\s*(\d+)\.\s+/g, (_, p1, n) => `${p1}Step ${n}: `);

  // gentle sentence splitting for long lines
  // add micro-pauses around conjunctions
  t = t
    .replace(/\s+(and|but|so)\s+/gi, " ... $1 ")
    .replace(/\s{2,}/g, " ");

  // add pauses after punctuation
  t = t.replace(/([.!?])\s+/g, "$1 ... ");

  // convert newlines to pauses (dad talking, not reading)
  t = t.replace(/\n+/g, " ... ");

  // avoid super long TTS requests (keeps stream snappy)
  if (t.length > 1600) t = t.slice(0, 1600) + " ...";

  return t.trim();
}

/* ---------------------------
   ElevenLabs streaming TTS
----------------------------*/
function voiceSettingsForMode(mode) {
  switch (mode) {
    case "coach":
      return { stability: 0.28, similarity_boost: 0.85, style: 0.55, use_speaker_boost: true };
    case "soft":
      return { stability: 0.35, similarity_boost: 0.9, style: 0.35, use_speaker_boost: true };
    case "tough":
      return { stability: 0.4, similarity_boost: 0.88, style: 0.25, use_speaker_boost: true };
    case "funny":
      return { stability: 0.25, similarity_boost: 0.82, style: 0.65, use_speaker_boost: true };
    case "dadjokes":
      return { stability: 0.22, similarity_boost: 0.8, style: 0.75, use_speaker_boost: true };
    default:
      return { stability: 0.3, similarity_boost: 0.88, style: 0.45, use_speaker_boost: true };
  }
}

async function streamElevenLabsTTS(res, text, mode = "default") {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    res.status(500).json({
      error: "Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID in Render Environment.",
    });
    return;
  }

  const dadText = humanCadenceText(text);
  const settings = voiceSettingsForMode(mode);

  const elevenUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`;

  const tts = await fetch(elevenUrl, {
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

  if (!tts.ok) {
    const errText = await tts.text();
    console.log("ElevenLabs error:", tts.status, errText);
    res.status(500).json({ error: "ElevenLabs TTS failed" });
    return;
  }

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Transfer-Encoding", "chunked");

  const nodeStream = Readable.fromWeb(tts.body);
  nodeStream.pipe(res);
}

/* ---------------------------
   Main endpoint used by app
----------------------------*/
app.post("/ask-dad", async (req, res) => {
  try {
    const { question, mode = "default", jokeHistory = [] } = req.body || {};
    console.log("📩 /ask-dad received:", { question, mode });

    const answer = await getDadAnswer({ question, mode, jokeHistory });

    // store payload so the client can GET audio without giant text URLs
    const ttsId = cacheTtsPayload({ text: answer, mode });

    return res.json({
      answer,
      ttsUrl: `/tts-stream/${ttsId}`,
    });
  } catch (e) {
    console.log("❌ /ask-dad crashed:", e);
    res.status(500).json({ error: "Server crashed" });
  }
});

/* ---------------------------
   Optional: create TTS id for any text
----------------------------*/
app.post("/tts-create", (req, res) => {
  const { text, mode = "default" } = req.body || {};
  if (!text) return res.status(400).json({ error: "Missing text" });
  const id = cacheTtsPayload({ text, mode });
  return res.json({ id, ttsUrl: `/tts-stream/${id}` });
});

/* ---------------------------
   Streaming voice endpoint (GET)
----------------------------*/
app.get("/tts-stream/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const entry = TTS_CACHE.get(id);
    if (!entry) return res.status(404).send("TTS expired or not found.");

    const payload = entry.payload || { text: "", mode: "default" };
    return streamElevenLabsTTS(res, payload.text, payload.mode || "default");
  } catch (e) {
    console.log("❌ /tts-stream crashed:", e);
    res.status(500).json({ error: "TTS stream crashed" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Ask Dad backend running");
  console.log("✅ Port:", PORT);
});
