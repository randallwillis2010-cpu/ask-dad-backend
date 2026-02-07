// server.js (Ask Dad + Dad Jokes + Homework Help w/ photo) — UPDATED for clearer Homework voice
import "dotenv/config";
import express from "express";
import cors from "cors";
import { Readable } from "node:stream";

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" })); // bigger because images

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
   Routes
----------------------------*/
app.get("/", (req, res) => res.send("✅ Ask Dad backend alive"));
app.get("/health", (req, res) => res.json({ ok: true }));

/* ---------------------------
   Mode prompts
----------------------------*/
function modeSystemPrompt(mode) {
  switch (mode) {
    case "homework":
      return `You are "Homework Dad": you help students solve homework step-by-step.
Rules:
- Be accurate and explain clearly.
- Show steps for math and science (units, formulas, and substitution).
- For writing, give structure, examples, and improvement suggestions.
- If the photo/question is unclear, ask ONE clarifying question, then provide what you can.
- Teach the method—don’t just drop a final answer.`;

    case "coach":
      return `You are "Dad Coach": upbeat, direct, motivating, short steps, confidence-building. No fluff.`;
    case "soft":
      return `You are "Soft Dad": warm, reassuring, patient, gentle humor, helps regulate emotions, small steps.`;
    case "tough":
      return `You are "No-Nonsense Dad": practical, blunt (not rude), safety-first, step-by-step, checks for tools/materials.`;
    case "funny":
      return `You are "Goofy Dad": playful, corny jokes sprinkled in, still helpful and step-by-step.`;
    case "dadjokes":
      return `You only tell ONE original dad joke per request. Must be new, not a classic from a known list. Short. Family-friendly.`;
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
    .replace(/[\u2019']/g, "'")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function isRepeatedJoke(joke, history = []) {
  const j = normalize(joke);
  return history.some((h) => normalize(h) === j);
}

async function callOpenAI({
  messages,
  temperature = 0.85,
  model = "gpt-4.1-mini",
}) {
  if (!OPENAI_API_KEY) {
    return { ok: false, text: "Missing OPENAI_API_KEY on backend." };
  }

  const body = { model, temperature, messages };

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
    return {
      ok: false,
      text: "Dad brain is busy right now. Try again in a minute.",
    };
  }

  const json = await r.json();
  const text = json?.choices?.[0]?.message?.content?.trim();
  return { ok: true, text: text || "…Dad blanked. Try again." };
}

async function getDadAnswer({ question, mode = "default", jokeHistory = [] }) {
  const system = modeSystemPrompt(mode);

  if (mode === "dadjokes") {
    const antiRepeat = jokeHistory?.length
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
      const r = await callOpenAI({ messages: baseMessages, temperature: 1.15 });
      const joke =
        (r.text || "").trim() || "My joke drawer glitched… hit me again 😄";
      if (!isRepeatedJoke(joke, jokeHistory)) return joke;

      baseMessages.push({
        role: "system",
        content:
          "Too similar. Generate a completely different new joke with a different topic.",
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

  const r = await callOpenAI({ messages, temperature: 0.85 });
  return r.text;
}

/* ---------------------------
   Homework Help (Vision + text)
----------------------------*/
function homeworkSystemPrompt() {
  return (
    `You are "Homework Dad": a kind, patient tutor.\n` +
    `Rules:\n` +
    `- Explain step-by-step clearly.\n` +
    `- Ask a clarifying question if the photo/question is unclear.\n` +
    `- Prefer teaching over just giving the final answer.\n` +
    `- If it's writing/essay: give an outline + 2-3 example sentences + improvements.\n` +
    `- If it’s math/science: show steps and reasoning.\n` +
    `- Keep it friendly and encouraging.\n`
  );
}

async function getHomeworkHelp({ question = "", imageBase64 = "" }) {
  const hasImage = !!imageBase64;
  const q = (question || "").trim();

  const userParts = [];

  userParts.push({
    type: "text",
    text:
      (q ? `Student question: ${q}\n\n` : "") +
      `If there is a worksheet/problem, explain how to solve it step-by-step. ` +
      `If the student could copy answers, steer them to learning: explain + show method.`,
  });

  if (hasImage) {
    userParts.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${imageBase64}`,
      },
    });
  }

  const messages = [
    { role: "system", content: homeworkSystemPrompt() },
    { role: "user", content: userParts },
  ];

  // If your model ever rejects images, switch to: "gpt-4.1" or "gpt-4o-mini"
  const r = await callOpenAI({
    messages,
    temperature: 0.7,
    model: "gpt-4.1-mini",
  });

  return (
    (r.text || "").trim() ||
    "Dad couldn’t read that clearly—try another photo with better lighting."
  );
}

/* ---------------------------
   TTS improvements (CLEAR homework voice)
   - Less aggressive cadence editing
   - Homework-friendly speech cleanup
   - Higher stability + lower style for homework
----------------------------*/
function voiceSettingsForMode(mode) {
  // Higher stability = clearer articulation
  // Lower style = less "character" slur
  switch (mode) {
    case "coach":
      return {
        stability: 0.45,
        similarity_boost: 0.88,
        style: 0.30,
        use_speaker_boost: true,
      };
    case "soft":
      return {
        stability: 0.50,
        similarity_boost: 0.90,
        style: 0.22,
        use_speaker_boost: true,
      };
    case "tough":
      return {
        stability: 0.55,
        similarity_boost: 0.88,
        style: 0.18,
        use_speaker_boost: true,
      };
    case "funny":
      return {
        stability: 0.42,
        similarity_boost: 0.86,
        style: 0.35,
        use_speaker_boost: true,
      };
    case "dadjokes":
      return {
        stability: 0.40,
        similarity_boost: 0.85,
        style: 0.38,
        use_speaker_boost: true,
      };
    case "homework":
      // MOST IMPORTANT: crisp homework reading
      return {
        stability: 0.62,
        similarity_boost: 0.92,
        style: 0.12,
        use_speaker_boost: true,
      };
    default:
      return {
        stability: 0.50,
        similarity_boost: 0.90,
        style: 0.24,
        use_speaker_boost: true,
      };
  }
}

function ttsFriendly(text) {
  // Helps math + symbols read cleanly
  return String(text || "")
    .replace(/\u00d7/g, " times ")
    .replace(/=/g, " equals ")
    .replace(/\+/g, " plus ")
    .replace(/\*/g, " times ")
    .replace(/\//g, " divided by ")
    .replace(/</g, " less than ")
    .replace(/>/g, " greater than ")
    .replace(/≤/g, " less than or equal to ")
    .replace(/≥/g, " greater than or equal to ")
    .replace(/\^/g, " to the power of ")
    .replace(/%/g, " percent ");
}

function humanCadenceText(input) {
  // IMPORTANT CHANGE: remove heavy pauses ("...") that can cause slurring
  let t = String(input || "").trim();

  t = t.replace(/\r/g, "");
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");

  // "1." -> "Step 1:"
  t = t.replace(/\b(\d+)[\)\.\:]\s+/g, "Step $1: ");

  // Light sentence spacing only; no comma pauses
  t = t.replace(/([.!?])\s+/g, "$1 ");

  // Keep it from getting too long (prevents artifacts)
  if (t.length > 1700) t = t.slice(0, 1700);

  return t.trim();
}

async function streamElevenLabsTTS(res, text, mode = "default") {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    res.status(500).json({
      error: "Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID.",
    });
    return;
  }

  const settings = voiceSettingsForMode(mode);

  // Homework clarity: sanitize symbols first, then light cadence
  const prepared = humanCadenceText(ttsFriendly(text));

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
        text: prepared,
        model_id: "eleven_turbo_v2_5",
        // Lower latency optimization can reduce quality; 1 is often clearer than 3
        optimize_streaming_latency: 1,
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
      try {
        res.end();
      } catch {}
    });
    nodeStream.pipe(res);
  } catch (e) {
    console.log("Readable.fromWeb failed:", e);
    res.status(500).json({ error: "Streaming conversion failed" });
  }
}

/* ---------------------------
   /ask-dad
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

/* ---------------------------
   /homework-help
----------------------------*/
app.post("/homework-help", async (req, res) => {
  try {
    const { question = "", imageBase64 = "" } = req.body || {};

    // Prevent giant payloads from crashing the server
    if (imageBase64 && imageBase64.length > 7_000_000) {
      return res.status(400).json({
        error: "Image too large. Try again with a clearer close-up photo.",
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

/* ---------------------------
   /tts-stream/:id
----------------------------*/
app.get("/tts-stream/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const entry = TTS_CACHE.get(id);
    if (!entry) return res.status(404).send("TTS expired or not found.");

    const payload = entry.payload || {};
    return streamElevenLabsTTS(
      res,
      payload.text || "",
      payload.mode || "default"
    );
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
