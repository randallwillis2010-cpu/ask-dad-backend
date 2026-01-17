import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 4000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🔊 temporary in-memory audio store
const audioStore = new Map();

app.get("/", (req, res) => {
  res.send("Ask Dad backend running (AI + voice)");
});

app.post("/ask-dad", async (req, res) => {
  try {
    const question = String(req.body?.question || "").trim();
    if (!question) {
      return res.json({ answer: "Ask me something, kiddo.", audioUrl: null });
    }

    // 🧠 REAL AI ANSWER
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content:
            "You are Dad: calm, supportive, practical, and encouraging. Give helpful step-by-step advice. Speak warmly.",
        },
        { role: "user", content: question },
      ],
    });

    const answer =
      completion.choices[0]?.message?.content ??
      "Dad's thinking cap fell off. Try again.";

    // 🎙️ ELEVENLABS VOICE
    let audioUrl = null;
    if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
      const tts = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": process.env.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: answer,
            model_id: "eleven_multilingual_v2",
            voice_settings: {
              stability: 0.45,
              similarity_boost: 0.8,
              style: 0.35,
            },
          }),
        }
      );

      if (tts.ok) {
        const buffer = Buffer.from(await tts.arrayBuffer());
        const id = crypto.randomBytes(10).toString("hex");
        audioStore.set(id, buffer);
        audioUrl = `${req.protocol}://${req.get("host")}/audio/${id}`;
      }
    }

    res.json({ answer, audioUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Dad server error" });
  }
});

app.get("/audio/:id", (req, res) => {
  const audio = audioStore.get(req.params.id);
  if (!audio) return res.sendStatus(404);
  res.setHeader("Content-Type", "audio/mpeg");
  res.send(audio);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Ask Dad backend running (AI + voice)");
});
