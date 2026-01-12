// server.js (FULL OFFLINE BACKEND — NO OPENAI)
const express = require("express");
const cors = require("cors");

const app = express();

// Allow requests from Expo / phone
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- GET routes (so browser doesn't show "Cannot GET") ----------
app.get("/", (req, res) => {
  res.send("✅ Ask Dad backend is alive (OFFLINE mode). Use POST /ask-dad");
});

app.get("/ask-dad", (req, res) => {
  res.send("✅ This endpoint expects POST JSON: { \"question\": \"...\" }");
});

// ---------- Offline Dad brain ----------
function offlineDadAnswer(questionRaw) {
  const q = String(questionRaw || "").trim().toLowerCase();

  if (!q) {
    return `Hey kiddo — toss me a question and I’ll do my best. 👋`;
  }

  // Lawn / mowing
  if (q.includes("mow") && q.includes("lawn")) {
    return [
      "Alright champ — we’re mowing like a responsible legend. 🧢",
      "",
      "1) Walk the yard first (sticks, rocks, toys = mower sadness).",
      "2) Set mower height to mid/high (scalping the lawn is not the vibe).",
      "3) Mow in straight lines, overlap a little each pass.",
      "4) Don’t rush — slow is smooth, smooth is fast.",
      "5) After: let mower cool, then clean it up and put it away.",
      "",
      "You’ve got this. One pass at a time. 💪",
    ].join("\n");
  }

  // Motivation / reassurance
  if (
    q.includes("motivated") ||
    q.includes("motivation") ||
    q.includes("stuck") ||
    q.includes("sad") ||
    q.includes("anxious") ||
    q.includes("stress")
  ) {
    return [
      "Come here, kiddo. You’re not broken — you’re human. 🤝",
      "",
      "Let’s do the soft-and-strong plan:",
      "• Pick ONE tiny thing you can do in 5 minutes.",
      "• Do it. Then breathe. Then pick the next tiny thing.",
      "",
      "Progress doesn’t need to be loud to be real. I’m proud of you for asking.",
    ].join("\n");
  }

  // Dad jokes
  if (q.includes("joke")) {
    const jokes = [
      "I used to hate facial hair… but then it grew on me.",
      "Why don’t eggs tell jokes? They’d crack each other up.",
      "I’m reading a book on anti-gravity. It’s impossible to put down.",
      "Did you hear about the restaurant on the moon? Great food, no atmosphere.",
    ];
    return jokes[Math.floor(Math.random() * jokes.length)] + " 😄";
  }

  // Default hybrid tone (funny + motivational + soft)
  return [
    "Alright kiddo — I hear you. 🧠❤️",
    "",
    `Here’s the move: take the next *small* step, not the perfect step.`,
    "If you tell me what you’re trying to do, I’ll walk you through it like we’re fixing a shelf together.",
    "",
    "You’re doing better than you think.",
  ].join("\n");
}

// ---------- POST endpoint used by the app ----------
app.post("/ask-dad", (req, res) => {
  try {
    const question = req.body?.question;

    console.log("📩 /ask-dad received:", req.body);

    // Always return JSON with {answer}
    const answer = offlineDadAnswer(question);
    return res.json({ answer });
  } catch (err) {
    console.error("❌ /ask-dad crashed:", err);
    return res.status(500).json({
      error: "Backend crashed",
      detail: String(err?.message || err),
    });
  }
});

// ---------- Start server ----------
const PORT = 4000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Ask Dad backend running (OFFLINE mode)");
  console.log(`✅ Local:  http://localhost:${PORT}`);
  console.log(`✅ Phone:  http://192.168.0.106:${PORT}/ask-dad  (POST only)`);
});
