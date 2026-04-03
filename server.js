

import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const USE_MOCK_AI = process.env.USE_MOCK_AI === "true";

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI in .env");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("Mongo connected"))
  .catch((err) => {
    console.error("Mongo connect error:", err);
    process.exit(1);
  });

/* ----------------------------- Schemas ----------------------------- */

const WordSchema = new mongoose.Schema(
  {
    input: { type: String, required: true },       // raw item like "figure out(разобраться)"
    baseText: { type: String, required: true },    // text without hint: "figure out"
    userHint: { type: String, default: null },     // raw hint from brackets
    lemma: { type: String, required: true },
    type: { type: String, enum: ["word", "phrase"], required: true },
    meaning: { type: String, required: true },
    meaningRu: { type: String, required: true },
    acceptedAnswers: [{ type: String }],           // for recall
    examples: [
      {
        en: { type: String, required: true },
        ru: { type: String, required: true },
      },
    ],
    practice: [
      {
        en: { type: String, required: true },
        ru: { type: String, required: true },
        answer: { type: String, required: true },
      },
    ],
    status: {
      type: String,
      enum: ["ready", "failed"],
      default: "ready",
    },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true }
);

const ProgressSchema = new mongoose.Schema(
  {
    wordId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Word",
      required: true,
      unique: true,
    },
    firstExposureDone: { type: Boolean, default: false },
    exposureAt: { type: Date, default: null },

    due: { type: Date, default: Date.now },
    stability: { type: Number, default: 0.3 },
    difficulty: { type: Number, default: 5.0 },
    reps: { type: Number, default: 0 },
    lapses: { type: Number, default: 0 },
    lastGrade: {
      type: String,
      enum: ["Again", "Hard", "Good", "Easy", null],
      default: null,
    },
    hintLevelUsedLastTime: { type: Number, default: 0 },

    // session stage after exposure
    nextMode: {
      type: String,
      enum: ["recall", "cloze"],
      default: "recall",
    },
  },
  { timestamps: true }
);

const Word = mongoose.model("Word", WordSchema);
const Progress = mongoose.model("Progress", ProgressSchema);

/* ----------------------------- Helpers ----------------------------- */

function parseInputItems(rawInput) {
  return rawInput
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
}

function extractBaseAndHint(input) {
  const match = input.match(/^(.*?)\((.*?)\)\s*$/);
  if (!match) {
    return {
      baseText: input.trim(),
      userHint: null,
    };
  }

  return {
    baseText: match[1].trim(),
    userHint: match[2].trim() || null,
  };
}

function normalizeAnswer(str) {
  return (str || "")
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ");
}

function isCorrectAnswer(userAnswer, acceptedAnswers) {
  const normUser = normalizeAnswer(userAnswer);
  return acceptedAnswers.some((a) => normalizeAnswer(a) === normUser);
}

function computeGrade({ correct, hintLevelUsed, answerTimeMs }) {
  if (!correct) return "Again";
  if (hintLevelUsed >= 2) return "Again";
  if (hintLevelUsed === 1) return "Hard";

  if (answerTimeMs <= 2500) return "Easy";
  if (answerTimeMs <= 6000) return "Good";
  return "Hard";
}

// simplified FSRS-like scheduler for MVP
function applyScheduler(progress, grade) {
  const now = new Date();

  let stability = progress.stability ?? 0.3;
  let difficulty = progress.difficulty ?? 5.0;
  let reps = progress.reps ?? 0;
  let lapses = progress.lapses ?? 0;

  if (grade === "Again") {
    lapses += 1;
    difficulty = Math.min(10, difficulty + 0.4);
    stability = Math.max(0.2, stability * 0.5);
    progress.due = new Date(now.getTime() + 10 * 60 * 1000); // 10 min
  } else if (grade === "Hard") {
    reps += 1;
    difficulty = Math.min(10, difficulty + 0.1);
    stability = stability * 1.2 + 0.3;
    const hours = Math.max(4, Math.round(stability * 8));
    progress.due = new Date(now.getTime() + hours * 60 * 60 * 1000);
  } else if (grade === "Good") {
    reps += 1;
    difficulty = Math.max(1, difficulty - 0.15);
    stability = stability * 1.8 + 0.8;
    const days = Math.max(1, Math.round(stability));
    progress.due = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  } else if (grade === "Easy") {
    reps += 1;
    difficulty = Math.max(1, difficulty - 0.25);
    stability = stability * 2.3 + 1.2;
    const days = Math.max(3, Math.round(stability * 1.5));
    progress.due = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  }

  progress.stability = Number(stability.toFixed(2));
  progress.difficulty = Number(difficulty.toFixed(2));
  progress.reps = reps;
  progress.lapses = lapses;
  progress.lastGrade = grade;

  return progress;
}

function validateGeneratedPack(pack) {
  if (!pack) return "Empty pack";
  if (!pack.lemma) return "Missing lemma";
  if (!pack.type) return "Missing type";
  if (!pack.meaning) return "Missing meaning";
  if (!pack.meaningRu) return "Missing meaningRu";
  if (!Array.isArray(pack.examples) || pack.examples.length === 0) {
    return "Missing examples";
  }
  if (!Array.isArray(pack.practice) || pack.practice.length === 0) {
    return "Missing practice";
  }

  for (const ex of pack.examples) {
    if (!ex.en || !ex.ru) return "Invalid example";
  }
  for (const p of pack.practice) {
    if (!p.en || !p.ru || !p.answer) return "Invalid practice";
  }

  return null;
}

function buildAcceptedAnswers(pack) {
  const set = new Set();
  if (pack.lemma) set.add(pack.lemma.trim());
  if (Array.isArray(pack.acceptedAnswers)) {
    for (const a of pack.acceptedAnswers) {
      if (a && a.trim()) set.add(a.trim());
    }
  }
  return [...set];
}

async function generatePackWithOpenAI({ input, baseText, userHint }) {
  if (USE_MOCK_AI) {
    return {
      lemma: baseText,
      type: baseText.includes(" ") ? "phrase" : "word",
      meaning: "a simple practical meaning",
      meaningRu: userHint || "примерный перевод",
      acceptedAnswers: [baseText],
      examples: [
        {
          en: `I use "${baseText}" in a simple sentence.`,
          ru: `Я использую "${baseText}" в простом предложении.`,
        },
        {
          en: `This is another short example with "${baseText}".`,
          ru: `Это ещё один короткий пример с "${baseText}".`,
        },
      ],
      practice: [
        {
          en: `I use _____ every day.`,
          ru: `Я использую это каждый день.`,
          answer: baseText,
        },
      ],
    };
  }

  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const systemPrompt = `
You are generating a tiny study pack for an English learner whose native language is Russian.
The user sends either:
- one English word
- one short phrase
- one short expression
Sometimes there is a raw hint from brackets. Use it only as a hint, not as a strict truth.

Your job:
1. Choose ONE main practical meaning.
2. Return ONLY valid JSON.
3. Keep output simple and short.
4. Examples must be short and practical.
5. Always include Russian translation.
6. For recall, acceptedAnswers may contain close acceptable variants if truly natural.
7. For cloze, answer must be exact for that sentence.

Return JSON with this shape:
{
  "lemma": "string",
  "type": "word or phrase",
  "meaning": "string",
  "meaningRu": "string",
  "acceptedAnswers": ["string"],
  "examples": [
    { "en": "string", "ru": "string" }
  ],
  "practice": [
    { "en": "string with blank _____", "ru": "string", "answer": "string" }
  ]
}
  `.trim();

  const userPrompt = `
originalInput: ${input}
baseText: ${baseText}
rawHint: ${userHint || ""}
  `.trim();

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const text = response.output_text;
  if (!text) {
    throw new Error("OpenAI returned empty response");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON from OpenAI: ${text}`);
  }

  return parsed;
}

/* ----------------------------- Routes ----------------------------- */

app.get("/api/health", async (_req, res) => {
  const mongoState = mongoose.connection.readyState;
  res.json({
    ok: true,
    mongoReadyState: mongoState,
    useMockAi: USE_MOCK_AI,
  });
});

app.get("/api/dashboard", async (_req, res) => {
  const now = new Date();

  const [totalWords, readyWords, failedWords, dueToday] = await Promise.all([
    Word.countDocuments(),
    Word.countDocuments({ status: "ready" }),
    Word.countDocuments({ status: "failed" }),
    Progress.countDocuments({
      firstExposureDone: true,
      due: { $lte: now },
    }),
  ]);

  res.json({
    totalWords,
    readyWords,
    failedWords,
    dueToday,
  });
});

app.get("/api/words", async (_req, res) => {
  const words = await Word.find().sort({ createdAt: -1 }).lean();
  const progressList = await Progress.find().lean();

  const progressMap = new Map(
    progressList.map((p) => [String(p.wordId), p])
  );

  const merged = words.map((w) => ({
    ...w,
    progress: progressMap.get(String(w._id)) || null,
  }));

  res.json(merged);
});

app.post("/api/words/generate", async (req, res) => {
  try {
    const { rawInput } = req.body || {};

    if (!rawInput || typeof rawInput !== "string") {
      return res.status(400).json({ error: "rawInput is required" });
    }

    const items = parseInputItems(rawInput);
    if (items.length === 0) {
      return res.status(400).json({ error: "No valid items found" });
    }

    const results = [];

    for (const item of items) {
      const { baseText, userHint } = extractBaseAndHint(item);

      if (!baseText) {
        results.push({
          input: item,
          status: "failed",
          error: "Empty baseText",
        });
        continue;
      }

      const existing = await Word.findOne({
        input: item,
      });

      if (existing) {
        results.push({
          input: item,
          status: "skipped",
          reason: "Already exists",
          wordId: existing._id,
        });
        continue;
      }

      try {
        const pack = await generatePackWithOpenAI({
          input: item,
          baseText,
          userHint,
        });

        const validationError = validateGeneratedPack(pack);
        if (validationError) {
          const failedWord = await Word.create({
            input: item,
            baseText,
            userHint,
            lemma: baseText,
            type: baseText.includes(" ") ? "phrase" : "word",
            meaning: "N/A",
            meaningRu: "N/A",
            examples: [{ en: "N/A", ru: "N/A" }],
            practice: [{ en: "N/A", ru: "N/A", answer: "N/A" }],
            status: "failed",
            errorMessage: validationError,
          });

          results.push({
            input: item,
            status: "failed",
            error: validationError,
            wordId: failedWord._id,
          });
          continue;
        }

        const acceptedAnswers = buildAcceptedAnswers(pack);

        const word = await Word.create({
          input: item,
          baseText,
          userHint,
          lemma: pack.lemma,
          type: pack.type,
          meaning: pack.meaning,
          meaningRu: pack.meaningRu,
          acceptedAnswers,
          examples: pack.examples.slice(0, 3),
          practice: pack.practice.slice(0, 2),
          status: "ready",
        });

        const progress = await Progress.create({
          wordId: word._id,
          firstExposureDone: false,
          due: new Date(),
          stability: 0.3,
          difficulty: 5.0,
          reps: 0,
          lapses: 0,
          lastGrade: null,
          hintLevelUsedLastTime: 0,
          nextMode: "recall",
        });

        results.push({
          input: item,
          status: "ready",
          wordId: word._id,
          progressId: progress._id,
        });
      } catch (err) {
        const failedWord = await Word.create({
          input: item,
          baseText,
          userHint,
          lemma: baseText,
          type: baseText.includes(" ") ? "phrase" : "word",
          meaning: "N/A",
          meaningRu: "N/A",
          examples: [{ en: "N/A", ru: "N/A" }],
          practice: [{ en: "N/A", ru: "N/A", answer: "N/A" }],
          status: "failed",
          errorMessage: err.message,
        });

        results.push({
          input: item,
          status: "failed",
          error: err.message,
          wordId: failedWord._id,
        });
      }
    }

    res.json({
      ok: true,
      total: items.length,
      results,
    });
  } catch (err) {
    console.error("POST /api/words/generate error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/session/next", async (_req, res) => {
  try {
    const now = new Date();

    // 1) first exposure not done yet
    const exposureProgress = await Progress.findOne({
      firstExposureDone: false,
    }).sort({ createdAt: 1 });

    if (exposureProgress) {
      const word = await Word.findById(exposureProgress.wordId).lean();
      if (word && word.status === "ready") {
        return res.json({
          mode: "first_exposure",
          wordId: word._id,
          lemma: word.lemma,
          meaning: word.meaning,
          meaningRu: word.meaningRu,
          examples: word.examples.slice(0, 3),
        });
      }
    }

    // 2) due review card
    const reviewProgress = await Progress.findOne({
      firstExposureDone: true,
      due: { $lte: now },
    }).sort({ due: 1 });

    if (!reviewProgress) {
      return res.json(null);
    }

    const word = await Word.findById(reviewProgress.wordId).lean();
    if (!word || word.status !== "ready") {
      return res.json(null);
    }

    if (reviewProgress.nextMode === "recall") {
      return res.json({
        mode: "recall",
        wordId: word._id,
        prompt: word.meaningRu,
        acceptedAnswers: word.acceptedAnswers, // можешь убрать на фронт, если не хочешь светить
      });
    }

    const cloze = word.practice?.[0];
    if (!cloze) {
      return res.json(null);
    }

    return res.json({
      mode: "cloze",
      wordId: word._id,
      prompt: cloze.en,
      promptRu: cloze.ru,
      acceptedAnswers: [cloze.answer], // можешь убрать на фронт
    });
  } catch (err) {
    console.error("GET /api/session/next error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/session/exposure-done", async (req, res) => {
  try {
    const { wordId } = req.body || {};
    if (!wordId) {
      return res.status(400).json({ error: "wordId is required" });
    }

    const progress = await Progress.findOne({ wordId });
    if (!progress) {
      return res.status(404).json({ error: "Progress not found" });
    }

    progress.firstExposureDone = true;
    progress.exposureAt = new Date();
    progress.due = new Date();
    progress.nextMode = "recall";
    await progress.save();

    res.json({
      ok: true,
      wordId,
      nextMode: progress.nextMode,
    });
  } catch (err) {
    console.error("POST /api/session/exposure-done error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/session/answer", async (req, res) => {
  try {
    const {
      wordId,
      mode,
      answer,
      hintLevelUsed = 0,
      answerTimeMs = 0,
    } = req.body || {};

    if (!wordId || !mode || typeof answer !== "string") {
      return res.status(400).json({
        error: "wordId, mode, answer are required",
      });
    }

    const word = await Word.findById(wordId);
    const progress = await Progress.findOne({ wordId });

    if (!word || !progress) {
      return res.status(404).json({ error: "Word or progress not found" });
    }

    let expectedAnswers = [];
    let expectedAnswerForResponse = "";

    if (mode === "recall") {
      expectedAnswers = word.acceptedAnswers || [word.lemma];
      expectedAnswerForResponse = word.lemma;
    } else if (mode === "cloze") {
      const practice = word.practice?.[0];
      if (!practice) {
        return res.status(400).json({ error: "No cloze practice found" });
      }
      expectedAnswers = [practice.answer];
      expectedAnswerForResponse = practice.answer;
    } else {
      return res.status(400).json({ error: "Invalid mode" });
    }

    const correct = isCorrectAnswer(answer, expectedAnswers);
    const appliedGrade = computeGrade({
      correct,
      hintLevelUsed,
      answerTimeMs,
    });

    progress.hintLevelUsedLastTime = hintLevelUsed;

    // simple lesson flow:
    // first due card => recall
    // then cloze
    // only after cloze do scheduler update
    if (mode === "recall") {
      progress.nextMode = "cloze";
      await progress.save();

      return res.json({
        ok: true,
        correct,
        expectedAnswer: expectedAnswerForResponse,
        appliedGrade,
        nextDue: progress.due,
        nextMode: "cloze",
      });
    }

    // cloze => finish review cycle and schedule next due
    progress.nextMode = "recall";
    applyScheduler(progress, appliedGrade);
    await progress.save();

    res.json({
      ok: true,
      correct,
      expectedAnswer: expectedAnswerForResponse,
      appliedGrade,
      nextDue: progress.due,
      nextMode: "recall",
    });
  } catch (err) {
    console.error("POST /api/session/answer error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ----------------------------- Start ----------------------------- */

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});


// // You are generating a vocabulary card for a Russian-speaking learner.
// // The learner wants to use the word in real life: at work, with friends, at brunch, in the street, and in the family.
// // Output MUST be ONLY a single JSON object. No markdown. No comments. No extra text.

// // BASE WORD (user input): "${word}"

// // CRITICAL OUTPUT RULES:
// // 1) Output must start with "{" and end with "}".
// // 2) Output must be valid JSON (double quotes for all keys/strings, no trailing commas).
// // 3) Do NOT include code fences like ```json.
// // 4) Do NOT include any keys other than the ones listed in the JSON SHAPE below.
// // 5) All strings must be non-empty after trimming (arrays may be empty).
// // 6) Use only standard ASCII quotes ".

// // JSON SHAPE (EXACT KEYS ONLY):
// // {
// //   "word": "${word}",
// //   "translations": [
// //     { "ru": "...", "primary": true },
// //     { "ru": "...", "primary": false }
// //   ],
// //   "usage_en": "...",
// //   "usage_ru": "...",
// //   "forms": [
// //     { "form": "...", "label_en": "...", "note_ru": "..." }
// //   ],
// //   "examples": [
// //     { "en": "...", "ru": "...", "target": "..." }
// //   ]
// // }

// // FIELD RULES:
// // A) word:
// // - Must equal exactly "${word}".

// // B) translations:
// // - Array with 1–3 items.
// // - Each item has exactly: { "ru": string, "primary": boolean }.
// // - Exactly ONE item must have "primary": true.
// // - "ru" must be Russian only (no English inside).

// // C) usage_en (IMPORTANT):
// // - 2 to 4 sentences in English.
// // - Explain meaning(s) and how to use it in everyday life + work.
// // - If the word_input can be used in TWO common ways (example: a past action vs a resulting state like "I destroyed..." vs "The room is destroyed"),
// //   you MUST explain BOTH uses clearly with simple patterns, e.g.:
// // - Explain 2–3 most common ways to use the word in real life. If the input form can mean both an action and a state/result, you MUST explain both.
// // - Keep it clear and practical, not academic.

// // D) usage_ru:
// // - Russian translation of usage_en

// // E) forms:
// // - If the word is used as a VERB form (including cases like "destroyed", "went"), provide EXACTLY 3 items:
// //   1) base form (label_en="base")
// //   2) past simple form (label_en="past")
// //   3) past participle form OR participle/adjective use (label_en="past_participle")
// // - NOTE: Sometimes past and past participle look the same (e.g., "destroyed"). In that case it is OK to repeat the same "form" text,
// //   but the note_ru must explain the difference (e.g., "прошедшее время" vs "причастие/состояние 'разрушенный'").
// // - If the word is NOT a verb or you are unsure, set "forms": [].
// // - Do NOT invent forms. Be conservative.

// // F) examples:
// // - Must be an array with EXACTLY 6 items.
// // - Examples must cover different real-life contexts (mix work + life), simple and natural:
// //   1) work message/status update
// //   2) meeting/discussion or teamwork
// //   3) family/home
// //   4) brunch/friends/social talk
// //   5) street/travel/daily life
// //   6) personal story/opinion about yourself
// // - Vocabulary restriction applies ONLY to examples:
// //   In "en" examples, besides the target itself, use only common words at B1 level or easier.
// //   Avoid idioms, slang, rare words, and complex phrasal verbs. Keep sentences short.

// // STRICT TARGET CONSTRAINTS (MANDATORY):
// // 1) "target" MUST be a single English token (one word only, no spaces).
// // 2) "target" MUST appear in "en" EXACTLY ONCE as a whole word (word boundary).
// // 3) Do NOT repeat the target in "en".
// // 4) NEVER set target to any JSON key name: word, translations, usage_en, usage_ru, forms, examples, en, ru, target.
// // 5) Prefer target to be exactly the word_input "${word}" when possible.

// // VALIDATION SAFETY REQUIREMENT (so parsing/validation is not painful):
// // - At least the FIRST 3 examples must be very simple and must use the word_input "${word}" as target.
// //   For these first 3 examples:
// //   - target MUST be exactly "${word}"
// //   - "${word}" must appear in "en" exactly once
// // - The last 3 examples may show other meanings/structures if relevant.

// // FINAL CHECKLIST (do silently):
// // - Valid JSON only, only allowed keys.
// // - translations length 1–3, exactly one primary=true.
// // - examples length = 6 with the required contexts.
// // - First 3 examples: target="${word}" and appears exactly once in en.
// // - Each example: target is one word and appears exactly once in en.

// // Return ONLY the JSON object.




// require("dotenv").config();
// const OpenAI = require("openai");

// const express = require("express");
// const mongoose = require("mongoose");
// const jwt = require("jsonwebtoken");
// const cookieParser = require("cookie-parser");
// const bcrypt = require("bcryptjs");
// const { v4: uuidv4 } = require("uuid");
// const cors = require("cors");
// const googleTTS = require("google-tts-api");
// const axios = require("axios");
// const app = express();
// app.use(express.json());
// app.use(cookieParser());

// app.use(
//   cors({
//     origin: ["http://localhost:3000", "https://englishtarapp.netlify.app"],
//     credentials: true,
//   })
// );

// mongoose.connect(process.env.MONGO_URL, {
//   useNewUrlParser: true,
//   useUnifiedTopology: true,
// });

// // ======= МОДЕЛЬ ПОЛЬЗОВАТЕЛЯ =======
// const UserSchema = new mongoose.Schema({
//   id: { type: String, default: uuidv4, unique: true }, // Генерируем UUID автоматически
//   email: { type: String, required: true, unique: true },
//   password: { type: String, required: true },
//   role: { type: String, default: "user" },
//   refreshTokens: [String],
// });
// const User = mongoose.model("User", UserSchema);

// // ======= МОДЕЛЬ ДЕФОЛТНЫХ СЛОВ=======
// const defaultWordSchema = new mongoose.Schema({
//   courseName: { type: String, required: true }, // Название курса
//   lessonName: { type: String, required: true }, // Название урока
//   word: { type: String, required: true }, // Слово
//   translation: { type: String, required: true }, // Перевод
// });

// const DefaultWord = mongoose.model("DefaultWord", defaultWordSchema);
// // ======= МОДЕЛЬ ДАННЫХ СЛОВ ПОЛЬЗОВАТЕЛЯ=======
// const wordSchema = new mongoose.Schema({
//   userId: { type: String, required: true }, // ID пользователя
//   courseName: { type: String, required: true }, // Название курса
//   lessonName: { type: String, required: true }, // Название урока
//   word: { type: String, required: true }, // Слово
//   knowledgeScore: { type: Number, default: 0 },
//   translation: { type: String, required: true }, // Перевод
//   repeats: { type: Number, default: 0 }, // Количество повторений
// });

// // ======= МОДЕЛЬ ДАННЫХ граматических предложений ПОЛЬЗОВАТЕЛЯ=======
// const grammarSchema = new mongoose.Schema({
//   userId: { type: String, required: true },
//   courseGrammarName: { type: String, required: true },
//   lessonGrammarName: { type: String, required: true },
//   sentenceGrammar: { type: String, required: true },
//   translation: { type: String, required: true },
//   extraWords: { type: [String], default: [] },
//   rules: { type: String },
//   repeats: { type: Number, default: 0 },
// });
// const Grammar = mongoose.model("Grammar", grammarSchema); // 👈 Вот этого не хватает!

// // ======= МОДЕЛЬ ПРОГРЕССА УРОКА =======
// const lessonProgressSchema = new mongoose.Schema({
//   userId: { type: String, required: true },
//   courseName: { type: String, required: true },
//   lessonName: { type: String, required: true },
//   repeats: { type: Number, default: 0 },
// });
// const LessonProgress = mongoose.model("LessonProgress", lessonProgressSchema);

// // ======= МОДЕЛЬ примеров использования слов =======
// const exampleSchema = new mongoose.Schema({
//   word: { type: String, required: true, unique: true }, // Одно слово
//   examples: { type: [String], required: true }, // Примеры
//   createdAt: { type: Date, default: Date.now },
// });

// const WordExample = mongoose.model("WordExample", exampleSchema);

// // ======= МОДЕЛЬ Повтора слов в вокабуляр =======
// const repetitionSchema = new mongoose.Schema({
//   userId: { type: String, required: true },
//   word: { type: String, required: true },
//   courseName: { type: String, required: true },
//   history: [
//     {
//       date: { type: Date, required: true },
//       status: {
//         type: String,
//         enum: ["new", "intro", "success", "fail"],
//         required: true,
//       },
//     },
//   ],
// });
// repetitionSchema.index({ userId: 1, word: 1, courseName: 1 }, { unique: true });
// const RepetitionProgress = mongoose.model("RepetitionProgress", repetitionSchema);

// // ======= МОДЕЛЬ ПРОГРЕССА граматики =======
// const grammarProgressSchema = new mongoose.Schema({
//   userId: { type: String, required: true },
//   courseGrammarName: { type: String, required: true },
//   lessonGrammarName: { type: String, required: true },
//   repeats: { type: Number, default: 0 },
// });

// const GrammarProgress = mongoose.model(
//   "GrammarProgress",
//   grammarProgressSchema
// );

// const Word = mongoose.model("Word", wordSchema);


// // ===== AI ENRICHMENT FOR VOCABULARY WORDS =====

// // ===== GLOBAL AI ENRICHMENT CACHE (shared for all users) =====

// const GlobalWordEnrichmentSchema = new mongoose.Schema(
//   {
//     word: { type: String, required: true, unique: true, index: true },

//     status: {
//       type: String,
//       enum: ["missing", "processing", "ready", "failed"],
//       default: "missing",
//       index: true,
//     },

//     translations: [
//       {
//         ru: { type: String, required: true },
//         primary: { type: Boolean, required: true },
//       },
//     ],

//     usage_en: { type: String, default: "" },
//     usage_ru: { type: String, default: "" },

//     // 6 examples
//     examples: [
//       {
//         en: { type: String, required: true },
//         ru: { type: String, required: true },
//         target: { type: String, required: true },
//       },
//     ],

//     // forms: [] или ровно 3 (base/past/past_participle)
//     forms: [
//       {
//         form: { type: String, required: true },
//         label_en: { type: String, required: true }, // base|past|past_participle
//         note_ru: { type: String, required: true },
//       },
//     ],

//     model: { type: String, default: "gpt-4.1-mini" },

//     openaiCalls: { type: Number, default: 0 },
//     lastCallAt: { type: Date, default: null },
//     error: { type: String, default: null },
//   },
//   { timestamps: true }
// );


// const GlobalWordEnrichment = mongoose.model(
//   "GlobalWordEnrichment",
//   GlobalWordEnrichmentSchema
// );




// //  переделать потом под разные языки перевода сейчас только английский русский


// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY,
// });

// async function enrichWordWithOpenAI(word, reqId = "no-id") {
//   const DEBUG_AI = process.env.DEBUG_AI === "1";
//   const tag = `[${reqId}]`;

//   const prompt = `
// You are generating a vocabulary card for a Russian-speaking learner.
// The learner wants to use the word in real life: at work, with friends, at brunch, in the street, and in the family.
// Output MUST be ONLY a single JSON object. No markdown. No comments. No extra text.

// BASE WORD (user input): "${word}"

// CRITICAL OUTPUT RULES:
// 1) Output must start with "{" and end with "}".
// 2) Output must be valid JSON (double quotes for all keys/strings, no trailing commas).
// 3) Do NOT include code fences like \`\`\`json.
// 4) Do NOT include any keys other than the ones listed in the JSON SHAPE below.
// 5) All strings must be non-empty after trimming (arrays may be empty).
// 6) Use only standard ASCII quotes ".

// JSON SHAPE (EXACT KEYS ONLY):
// {
//   "word": "${word}",
//   "translations": [
//     { "ru": "...", "primary": true },
//     { "ru": "...", "primary": false }
//   ],
//   "usage_en": "...",
//   "usage_ru": "...",
//   "forms": [
//     { "form": "...", "label_en": "...", "note_ru": "..." }
//   ],
//   "examples": [
//     { "en": "...", "ru": "...", "target": "..." }
//   ]
// }

// FIELD RULES:
// A) word:
// - Must equal exactly "${word}".

// B) translations:
// - Array with 1–3 items.
// - Each item has exactly: { "ru": string, "primary": boolean }.
// - Exactly ONE item must have "primary": true.
// - "ru" must be Russian only (no English inside).

// C) usage_en (IMPORTANT):
// - 2 to 4 sentences in English.
// - Explain meaning(s) and how to use it in everyday life + work.
// - If the word_input can be used in TWO common ways (example: a past action vs a resulting state like "I destroyed..." vs "The room is destroyed"),
//   you MUST explain BOTH uses clearly with simple patterns, e.g.:
// - Explain 2–3 most common ways to use the word in real life. If the input form can mean both an action and a state/result, you MUST explain both.
// - Keep it clear and practical, not academic.

// D) usage_ru:
// - Russian translation of usage_en

// E) forms:
// - If the word is used as a VERB form (including cases like "destroyed", "went"), provide EXACTLY 3 items:
//   1) base form (label_en="base")
//   2) past simple form (label_en="past")
//   3) past participle form OR participle/adjective use (label_en="past_participle")
// - NOTE: Sometimes past and past participle look the same (e.g., "destroyed"). In that case it is OK to repeat the same "form" text,
//   but the note_ru must explain the difference (e.g., "прошедшее время" vs "причастие/состояние 'разрушенный'").
// - If the word is NOT a verb or you are unsure, set "forms": [].
// - Do NOT invent forms. Be conservative.

// F) examples:
// - Must be an array with EXACTLY 6 items.
// - Examples must cover different real-life contexts (mix work + life), simple and natural:
//   1) work message/status update
//   2) meeting/discussion or teamwork
//   3) family/home
//   4) brunch/friends/social talk
//   5) street/travel/daily life
//   6) personal story/opinion about yourself
// - Vocabulary restriction applies ONLY to examples:
//   In "en" examples, besides the target itself, use only common words at B1 level or easier.
//   Avoid idioms, slang, rare words, and complex phrasal verbs. Keep sentences short.

// STRICT TARGET CONSTRAINTS (MANDATORY):
// 1) "target" MUST be a single English token (one word only, no spaces).
// 2) "target" MUST appear in "en" EXACTLY ONCE as a whole word (word boundary).
// 3) Do NOT repeat the target in "en".
// 4) NEVER set target to any JSON key name: word, translations, usage_en, usage_ru, forms, examples, en, ru, target.
// 5) Prefer target to be exactly the word_input "${word}" when possible.

// VALIDATION SAFETY REQUIREMENT (so parsing/validation is not painful):
// - At least the FIRST 3 examples must be very simple and must use the word_input "${word}" as target.
//   For these first 3 examples:
//   - target MUST be exactly "${word}"
//   - "${word}" must appear in "en" exactly once
// - The last 3 examples may show other meanings/structures if relevant.

// FINAL CHECKLIST (do silently):
// - Valid JSON only, only allowed keys.
// - translations length 1–3, exactly one primary=true.
// - examples length = 6 with the required contexts.
// - First 3 examples: target="${word}" and appears exactly once in en.
// - Each example: target is one word and appears exactly once in en.

// Return ONLY the JSON object.
// `.trim();

//   const safeJsonParse = (t) => {
//     const raw = String(t || "").trim();
//     if (!raw) return null;
//     const cleaned = raw
//       .replace(/^```(?:json)?\s*/i, "")
//       .replace(/```\s*$/i, "")
//       .trim();
//     try {
//       return JSON.parse(cleaned);
//     } catch {
//       return null;
//     }
//   };

//   // --- общая валидация результата ---
//   const validate = (parsed) => {
//     if (!parsed || typeof parsed !== "object") throw new Error("AI response is not valid JSON");

//     if (String(parsed.word || "").trim().toLowerCase() !== word.toLowerCase()) {
//       throw new Error("AI response: word mismatch");
//     }

//     if (!Array.isArray(parsed.translations) || parsed.translations.length < 1 || parsed.translations.length > 3) {
//       throw new Error("AI response: translations invalid");
//     }
//     if (!parsed.translations.some((t) => t && t.primary === true && String(t.ru || "").trim())) {
//       throw new Error("AI response: primary translation missing");
//     }

//     if (!String(parsed.usage_en || "").trim()) throw new Error("AI response: usage_en missing");
//     if (!String(parsed.usage_ru || "").trim()) throw new Error("AI response: usage_ru missing");

//     if (!Array.isArray(parsed.examples) || parsed.examples.length !== 6) {
//       throw new Error("AI response: examples must be exactly 6");
//     }

//     const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
//     const countOcc = (en, target) => {
//       const re = new RegExp(`\\b${escapeRegExp(target)}\\b`, "gi");
//       return (String(en).match(re) || []).length;
//     };
//     const forbiddenTargets = new Set(["word","translations","usage_en","usage_ru","forms","examples","en","ru","target"]);

//     for (const ex of parsed.examples) {
//       const target = String(ex.target || "").trim();
//       if (!target || target.includes(" ")) throw new Error(`AI response: invalid target "${target}"`);
//       if (forbiddenTargets.has(target)) throw new Error(`AI response: forbidden target "${target}"`);
//       if (countOcc(ex.en, target) !== 1) throw new Error(`AI response: target "${target}" not exactly once`);
//     }

//     if (!Array.isArray(parsed.forms)) parsed.forms = [];
//     if (!(parsed.forms.length === 0 || parsed.forms.length === 3)) {
//       throw new Error("AI response: forms must be [] or exactly 3 items");
//     }

//     return parsed;
//   };

//   const maxAttempts = 2;
//   let lastErr = null;

//   for (let attempt = 1; attempt <= maxAttempts; attempt++) {
//     try {
//       if (DEBUG_AI) console.log(`${tag} AI attempt ${attempt} start`, { word });

//       const response = await openai.responses.create({
//         model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
//         input: prompt,
//       });

//       const text = String(response?.output_text || "");
//       if (DEBUG_AI) {
//         console.log(`${tag} AI attempt ${attempt} raw`, {
//           output_text_len: text.length,
//           output_text_head: text.slice(0, 1200),
//         });
//       }

//       const parsed = safeJsonParse(text);
//       return validate(parsed);
//     } catch (e) {
//       lastErr = e;
//       console.error(`${tag} AI attempt ${attempt} failed:`, e?.message || e);
//       // второй раз — последний, дальше не тратим деньги
//     }
//   }

//   throw lastErr || new Error("AI enrichment failed");
// }



// const generateAccessToken = (user) => {
//   return jwt.sign(
//     { userId: user.id, role: user.role }, // Используем `user.id`
//     process.env.ACCESS_SECRET,
//     { expiresIn: "15m" }
//   );
// };



// const generateRefreshToken = (user) => {
//   return jwt.sign({ userId: user.id }, process.env.REFRESH_SECRET, {
//     expiresIn: "14d",
//   });
// };


// app.use((req, res, next) => {
//   req.reqId = req.headers["x-request-id"] || uuidv4();
//   res.setHeader("x-request-id", req.reqId);
//   next();
// });

// // ======= РЕГИСТРАЦИЯ =======
// app.post("/auth/register", async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     const hashedPassword = await bcrypt.hash(password, 10);

//     const user = new User({
//       email,
//       password: hashedPassword,
//       refreshTokens: [],
//     });

//     await user.save();
//     res.status(201).json({ message: "User registered", userId: user.id });
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error registering user", error: error.message });
//   }
// });

// // ======= ЛОГИН =======
// app.post("/auth/login", async (req, res) => {
//   const { email, password } = req.body;
//   const user = await User.findOne({ email });

//   if (!user || !(await bcrypt.compare(password, user.password))) {
//     return res.status(401).json({ message: "Invalid credentials" });
//   }

//   const accessToken = generateAccessToken(user);
//   const refreshToken = generateRefreshToken(user);

//   // ✅ Добавляем `refreshToken` в массив
//   user.refreshTokens.push(refreshToken);
//   await user.save();

//   res.cookie("refreshToken", refreshToken, {
//     httpOnly: true,
//     secure: true,
//     sameSite: "Strict",
//   });

//   res.json({ accessToken });
// });

// // ======= ОБНОВЛЕНИЕ ТОКЕНОВ =======
// app.post("/auth/refresh", async (req, res) => {
//   const refreshToken = req.cookies.refreshToken;
//   if (!refreshToken) return res.sendStatus(401);

//   try {
//     const decoded = jwt.verify(refreshToken, process.env.REFRESH_SECRET);
//     const user = await User.findOne({
//       id: decoded.userId,
//       refreshTokens: { $in: [refreshToken] },
//     });

//     if (!user) {
//       return res.sendStatus(403);
//     }

//     // ✅ Удаляем старый `refreshToken`
//     user.refreshTokens = user.refreshTokens.filter(
//       (token) => token !== refreshToken
//     );

//     // ✅ Генерируем новый `refreshToken`
//     const newAccessToken = generateAccessToken(user);
//     const newRefreshToken = generateRefreshToken(user);

//     // ✅ Добавляем новый `refreshToken` в массив
//     user.refreshTokens.push(newRefreshToken);
//     await user.save();

//     res.cookie("refreshToken", newRefreshToken, {
//       httpOnly: true,
//       secure: true,
//       sameSite: "Strict",
//     });

//     res.json({ accessToken: newAccessToken });
//   } catch {
//     res.sendStatus(403);
//   }
// });

// // ======= ВЫХОД (LOGOUT) =======
// app.post("/auth/logout", async (req, res) => {
//   const refreshToken = req.cookies.refreshToken;
//   if (!refreshToken) return res.sendStatus(204);

//   // ✅ Поиск пользователя, у которого есть этот refreshToken
//   const user = await User.findOne({ refreshTokens: { $in: [refreshToken] } });

//   if (user) {
//     user.refreshTokens = user.refreshTokens.filter(
//       (token) => token !== refreshToken
//     );
//     await user.save();
//   }

//   res.clearCookie("refreshToken");
//   res.sendStatus(204);
// });

// // ======= ПРОТЕКТИРОВАННЫЙ ЭНДПОИНТ =======
// const authMiddleware = (req, res, next) => {
//   const authHeader = req.headers.authorization;
//   if (!authHeader || !authHeader.startsWith("Bearer ")) {
//     return res.sendStatus(401);
//   }

//   const token = authHeader.split(" ")[1];

//   jwt.verify(token, process.env.ACCESS_SECRET, (err, decoded) => {
//     if (err) return res.sendStatus(403);
//     req.user = decoded;
//     next();
//   });
// };

// app.get("/protected", authMiddleware, (req, res) => {
//   res.json({ message: "This is a protected route", user: req.user });
// });

// // ======= ЭНДПОИНТ =======

// // app.post("/words", async (req, res) => {
// //   try {
// //     const { userId, courseName, lessonName, word, translation } = req.body;

// //     const newWord = new Word({
// //       userId,
// //       courseName,
// //       lessonName,
// //       word,
// //       translation,
// //       repeats: 0,
// //     });

// //     await newWord.save();
// //     res.status(201).json({ message: "Word added", word: newWord });
// //   } catch (error) {
// //     res
// //       .status(500)
// //       .json({ message: "Error adding word", error: error.message });
// //   }
// // });




// // ===== AI WORD ENRICHMENT ENDPOINT =====

// // ===== GLOBAL AI WORD ENRICHMENT ENDPOINTS (shared cache) =====

// // GET: проверить кеш (готово/нет) по слову
// app.get("/ai/enrich-word", async (req, res) => {
//   try {
//     const raw = (req.query.word || "").toString();
//     const word = raw.trim().toLowerCase();

//     if (!word) return res.status(400).json({ error: "word query param required" });
//     if (word.length > 64) return res.status(400).json({ error: "word too long" });

//     const enrichment = await GlobalWordEnrichment.findOne({ word }).lean();
//     if (!enrichment) return res.status(404).json({ status: "missing" });

//     return res.json(enrichment);
//   } catch (err) {
//     console.error("GLOBAL AI enrich GET error:", err);
//     return res.status(500).json({ error: "Server error" });
//   }
// });


// // POST: если нет кеша — вызвать OpenAI, сохранить, вернуть
// app.post("/ai/enrich-word", async (req, res) => {
//   const reqId = req.reqId || "no-id";

//   try {
//     const raw = (req.body?.word || "").toString();
//     const word = raw.trim().toLowerCase();

//     if (!word) return res.status(400).json({ error: "word required" });
//     if (word.length > 64) return res.status(400).json({ error: "word too long" });

//     // 1) если уже готово — вернуть сразу
//     const existing = await GlobalWordEnrichment.findOne({ word });
//     if (existing?.status === "ready") return res.json(existing);

//     // 2) если кто-то уже генерит — не тратим деньги
//     if (existing?.status === "processing") {
//       return res.status(202).json({ status: "processing" });
//     }

//     // 3) атомарно захватить "processing"
//     let claimed;
//     try {
//       claimed = await GlobalWordEnrichment.findOneAndUpdate(
//         { word, status: { $ne: "processing" } },
//         {
//           $setOnInsert: { word },
//           $set: { status: "processing", error: null, lastCallAt: new Date(), model: (process.env.OPENAI_MODEL || "gpt-4.1-mini") },
//           $inc: { openaiCalls: 1 },
//         },
//         { new: true, upsert: true }
//       );
//     } catch (e) {
//       // гонка на unique word
//       if (e?.code === 11000) {
//         return res.status(202).json({ status: "processing" });
//       }
//       throw e;
//     }

//     // если по какой-то причине не удалось “захватить”
//     if (!claimed || claimed.status !== "processing") {
//       return res.status(202).json({ status: "processing" });
//     }

//     console.log(`[${reqId}] CALL AI (GLOBAL) word=${word}`);

//     // 4) платный вызов (внутри retry максимум 2 попытки)
//     const aiData = await enrichWordWithOpenAI(word, reqId);

//     // 5) сохранить результат (ТОЛЬКО новый контракт)
//     const updated = await GlobalWordEnrichment.findOneAndUpdate(
//       { word },
//       {
//         $set: {
//           translations: aiData.translations || [],
//           usage_en: aiData.usage_en || "",
//           usage_ru: aiData.usage_ru || "",
//           examples: aiData.examples || [],
//           forms: Array.isArray(aiData.forms) ? aiData.forms : [],
//           status: "ready",
//           error: null,
//           lastCallAt: new Date(),
//           model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
//         },
//       },
//       { new: true }
//     );

//     return res.json(updated);
//   } catch (err) {
//     console.error(`[${reqId}] GLOBAL AI enrich POST error:`, err);

//     // пометить failed
//     try {
//       const raw = (req.body?.word || "").toString();
//       const word = raw.trim().toLowerCase();
//       if (word) {
//         await GlobalWordEnrichment.findOneAndUpdate(
//           { word },
//           { $set: { status: "failed", error: err?.message || "Enrichment failed", lastCallAt: new Date() } },
//           { new: true }
//         );
//       }
//     } catch {}

//     return res.status(500).json({ error: err?.message || "Server error" });
//   }
// });



// app.post("/words", async (req, res) => {
//   try {
//     const data = req.body;

//     if (Array.isArray(data)) {
//       const inserted = await Word.insertMany(data);
//       return res.status(201).json({ message: "Words added", inserted });
//     } else {
//       const word = new Word(data);
//       await word.save();
//       return res.status(201).json({ message: "Word added", word });
//     }
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error adding word", error: error.message });
//   }
// });

// app.get("/words/:userId", async (req, res) => {
//   try {
//     const words = await Word.find({ userId: req.params.userId });
//     res.json(words);
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error fetching words", error: error.message });
//   }
// });
// app.get("/courses/:userId", async (req, res) => {
//   try {
//     const { userId } = req.params;

//     // Получаем уникальные названия курсов пользователя
//     const courses = await Word.distinct("courseName", { userId });

//     res.json({ courses });
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error fetching courses", error: error.message });
//   }
// });
// app.get("/lessons/:userId/:courseName", async (req, res) => {
//   try {
//     const { userId, courseName } = req.params;

//     // Получаем уникальные названия уроков пользователя в данном курсе
//     const lessons = await Word.distinct("lessonName", { userId, courseName });

//     res.json({ lessons });
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Ошибка получения уроков", error: error.message });
//   }
// });

// app.post("/load-defaults", async (req, res) => {
//   try {
//     const { userId } = req.body;

//     if (!userId) {
//       return res.status(400).json({ message: "User ID is required" });
//     }

//     // ✅ Проверяем, загружены ли уже слова
//     const existingWords = await Word.findOne({ userId });
//     if (existingWords) {
//       return res
//         .status(400)
//         .json({ message: "Words already loaded for this user" });
//     }

//     const defaultWords = await DefaultWord.find();
//     if (!defaultWords.length) {
//       return res.status(404).json({ message: "No default words found" });
//     }

//    const userWords = defaultWords.map((w) => ({
//   userId,
//   courseName: w.courseName,
//   lessonName: w.lessonName,
//   word: w.word,
//   translation: w.translation,
//   repeats: 0,
// }));

// const inserted = await Word.insertMany(userWords);
// res.status(201).json({ message: "Courses and words loaded", words: inserted });

//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error loading defaults", error: error.message });
//   }
// });

// app.get("/words/:userId/:courseName/:lessonName", async (req, res) => {
//   try {
//     const words = await Word.find({
//       userId: req.params.userId,
//       courseName: req.params.courseName,
//       lessonName: req.params.lessonName,
//     });
//     res.json(words);
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error fetching words", error: error.message });
//   }
// });

// app.post("/admin/words", async (req, res) => {
//   try {
//     const insertedWords = await DefaultWord.insertMany(req.body);
//     res
//       .status(201)
//       .json({ message: "Default words uploaded", words: insertedWords });
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error uploading default words", error: error.message });
//   }
// });

// app.post("/lesson-progress", async (req, res) => {
//   try {
//     const { userId, courseName, lessonName } = req.body;

//     const existing = await LessonProgress.findOne({
//       userId,
//       courseName,
//       lessonName,
//     });
//     if (existing) {
//       return res
//         .status(400)
//         .json({ message: "Progress already exists for this lesson" });
//     }

//     const progress = new LessonProgress({ userId, courseName, lessonName });
//     await progress.save();
//     res.status(201).json({ message: "Lesson progress created", progress });
//   } catch (error) {
//     res.status(500).json({
//       message: "Error creating lesson progress",
//       error: error.message,
//     });
//   }
// });

// // исползовать для обнуления ведь этот ендпоинт просто сохраняет число
// app.put("/lesson-progress", async (req, res) => {
//   try {
//     const { userId, courseName, lessonName, repeats } = req.body;

//     const progress = await LessonProgress.findOneAndUpdate(
//       { userId, courseName, lessonName },
//       { repeats },
//       { new: true }
//     );

//     if (!progress) {
//       return res.status(404).json({ message: "Progress not found" });
//     }

//     res.json({ message: "Repeats updated", progress });
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error updating repeats", error: error.message });
//   }
// });

// // использовать для увеличения повторов на +1 если записи нет то ее создаем
// app.patch("/lesson-progress/increment", async (req, res) => {
//   try {
//     const { userId, courseName, lessonName } = req.body;

//     const progress = await LessonProgress.findOneAndUpdate(
//       { userId, courseName, lessonName },
//       { $inc: { repeats: 1 } },
//       {
//         new: true,
//         upsert: true, // создаёт запись, если её нет
//         setDefaultsOnInsert: true, // если ты используешь default-поля в схеме
//       }
//     );

//     res.json({ message: "Repeats incremented or created", progress });
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error incrementing repeats", error: error.message });
//   }
// });

// app.get("/lesson-progress/:userId/:courseName", async (req, res) => {
//   try {
//     const { userId, courseName } = req.params;
//     const progress = await LessonProgress.find({ userId, courseName });
//     res.json(progress);
//   } catch (error) {
//     res.status(500).json({
//       message: "Error fetching lesson progress",
//       error: error.message,
//     });
//   }
// });

// app.get("/speak/:word", async (req, res) => {
//   const { word } = req.params;

//   try {
//     const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
//       word
//     )}&tl=en-us&client=tw-ob`;

//     const response = await axios.get(url, {
//       responseType: "stream",
//       headers: {
//         "User-Agent":
//           "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
//       },
//     });

//     res.set({
//       "Content-Type": "audio/mpeg",
//       "Content-Disposition": `inline; filename="${word}.mp3"`,
//     });

//     response.data.pipe(res);
//   } catch (error) {
//     console.error("Ошибка при получении озвучки:", error.message);
//     res.status(500).json({ message: "Error generating speech" });
//   }
// });

// //======grammar
// // получить все курсы грамматики
// app.get("/grammar-courses/:userId", async (req, res) => {
//   try {
//     const courses = await Grammar.distinct("courseGrammarName", {
//       userId: req.params.userId,
//     });
//     res.json({ courses });
//   } catch (error) {
//     res.status(500).json({
//       message: "Error fetching grammar courses",
//       error: error.message,
//     });
//   }
// });

// // получить уроки внутри курса
// app.get("/grammar-lessons/:userId/:courseGrammarName", async (req, res) => {
//   try {
//     const lessons = await Grammar.distinct("lessonGrammarName", {
//       userId: req.params.userId,
//       courseGrammarName: req.params.courseGrammarName,
//     });
//     res.json({ lessons });
//   } catch (error) {
//     res.status(500).json({
//       message: "Error fetching grammar lessons",
//       error: error.message,
//     });
//   }
// });

// // получить предложения внутри урока
// app.get(
//   "/grammar/:userId/:courseGrammarName/:lessonGrammarName",
//   async (req, res) => {
//     try {
//       const items = await Grammar.find({
//         userId: req.params.userId,
//         courseGrammarName: req.params.courseGrammarName,
//         lessonGrammarName: req.params.lessonGrammarName,
//       });
//       res.json(items);
//     } catch (error) {
//       res.status(500).json({
//         message: "Error fetching grammar items",
//         error: error.message,
//       });
//     }
//   }
// );

// // добавить предложение добавлял только одно предложение за запрос
// // app.post("/grammar", async (req, res) => {
// //   try {
// //     const grammar = new Grammar(req.body);
// //     await grammar.save();
// //     res.status(201).json({ message: "Grammar entry saved", grammar });
// //   } catch (error) {
// //     res
// //       .status(500)
// //       .json({ message: "Error saving grammar", error: error.message });
// //   }
// // });

// app.post("/grammar", async (req, res) => {
//   try {
//     const data = req.body;

//     if (Array.isArray(data)) {
//       const inserted = await Grammar.insertMany(data);
//       return res
//         .status(201)
//         .json({ message: "Grammar entries saved", inserted });
//     } else {
//       const grammar = new Grammar(data);
//       await grammar.save();
//       return res.status(201).json({ message: "Grammar entry saved", grammar });
//     }
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error saving grammar", error: error.message });
//   }
// });

// app.patch("/grammar-progress/increment", async (req, res) => {
//   try {
//     const { userId, courseGrammarName, lessonGrammarName } = req.body;

//     const progress = await GrammarProgress.findOneAndUpdate(
//       { userId, courseGrammarName, lessonGrammarName },
//       { $inc: { repeats: 1 } },
//       {
//         new: true,
//         upsert: true,
//         setDefaultsOnInsert: true,
//       }
//     );

//     res.json({ message: "Grammar progress updated", progress });
//   } catch (error) {
//     res.status(500).json({
//       message: "Error updating grammar progress",
//       error: error.message,
//     });
//   }
// });

// app.get("/grammar-progress/:userId/:courseGrammarName", async (req, res) => {
//   try {
//     const { userId, courseGrammarName } = req.params;

//     const progress = await GrammarProgress.find({ userId, courseGrammarName });
//     res.json(progress);
//   } catch (error) {
//     res.status(500).json({
//       message: "Error fetching grammar progress",
//       error: error.message,
//     });
//   }
// });
// app.put("/grammar-progress", async (req, res) => {
//   try {
//     const { userId, courseGrammarName, lessonGrammarName, repeats } = req.body;

//     const progress = await GrammarProgress.findOneAndUpdate(
//       { userId, courseGrammarName, lessonGrammarName },
//       { repeats },
//       { new: true }
//     );

//     if (!progress) {
//       return res.status(404).json({ message: "Progress not found" });
//     }

//     res.json({ message: "Repeats reset successfully", progress });
//   } catch (error) {
//     res.status(500).json({
//       message: "Error resetting grammar progress",
//       error: error.message,
//     });
//   }
// });
// app.put("/grammar/:id", async (req, res) => {
//   try {
//     const updated = await Grammar.findByIdAndUpdate(req.params.id, req.body, {
//       new: true,
//     });

//     if (!updated) {
//       return res.status(404).json({ message: "Sentence not found" });
//     }

//     res.json({ message: "Sentence updated", updated });
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error updating sentence", error: error.message });
//   }
// });
// app.delete(
//   "/grammar/:userId/:courseGrammarName/:lessonGrammarName",
//   async (req, res) => {
//     try {
//       const { userId, courseGrammarName, lessonGrammarName } = req.params;
//       const result = await Grammar.deleteMany({
//         userId,
//         courseGrammarName,
//         lessonGrammarName,
//       });

//       // Также удалить прогресс:
//       await GrammarProgress.deleteOne({
//         userId,
//         courseGrammarName,
//         lessonGrammarName,
//       });

//       res.json({
//         message: "Lesson deleted",
//         deletedCount: result.deletedCount,
//       });
//     } catch (error) {
//       res
//         .status(500)
//         .json({ message: "Error deleting lesson", error: error.message });
//     }
//   }
// );
// app.get("/words/:userId/:courseName", async (req, res) => {
//   try {
//     const { userId, courseName } = req.params;
//     const words = await Word.find({ userId, courseName });

//     res.status(200).json({
//       success: true,
//       message: "Words loaded for course",
//       data: words,
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: "Error fetching words",
//       error: error.message,
//     });
//   }
// });

// app.delete("/words/:userId/:courseName/:lessonName", async (req, res) => {
//   try {
//     const { userId, courseName, lessonName } = req.params;
//     const result = await Word.deleteMany({
//       userId,
//       courseName,
//       lessonName,
//     });

//     // Также можно удалить LessonProgress:
//     await LessonProgress.deleteOne({
//       userId,
//       courseName,
//       lessonName,
//     });

//     res.json({ message: "Lesson deleted", deletedCount: result.deletedCount });
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error deleting lesson", error: error.message });
//   }
// });

// app.post("/examples", async (req, res) => {
//   const data = req.body;
//   if (!data) return res.status(400).json({ message: "No data provided" });

//   const items = Array.isArray(data) ? data : [data];
//   let inserted = 0;
//   let updated = 0;
//   let skipped = 0;

//   for (const item of items) {
//     if (!item.word || !Array.isArray(item.examples)) {
//       skipped++;
//       continue;
//     }

//     try {
//       const existing = await WordExample.findOne({ word: item.word });

//       if (existing) {
//         const combined = [...existing.examples, ...item.examples];
//         const uniqueExamples = [...new Set(combined)];
//         if (uniqueExamples.length !== existing.examples.length) {
//           existing.examples = uniqueExamples;
//           await existing.save();
//           updated++;
//         } else {
//           skipped++;
//         }
//       } else {
//         await WordExample.create({
//           word: item.word,
//           examples: [...new Set(item.examples)],
//         });
//         inserted++;
//       }
//     } catch (error) {
//       console.error(`Error processing word "${item.word}":`, error.message);
//       skipped++;
//     }
//   }

//   return res.status(200).json({ inserted, updated, skipped });
// });

// app.get("/examples/:word", async (req, res) => {
//   try {
//     const example = await WordExample.findOne({ word: req.params.word });
//     if (!example) return res.status(404).json({ message: "Not found" });
//     return res.json(example);
//   } catch (error) {
//     return res
//       .status(500)
//       .json({ message: "Fetch error", error: error.message });
//   }
// });

// app.put("/examples/:word", async (req, res) => {
//   const newExamples = req.body.examples;

//   if (!Array.isArray(newExamples)) {
//     return res.status(400).json({ message: "examples must be an array" });
//   }

//   try {
//     const entry = await WordExample.findOne({ word: req.params.word });
//     if (!entry) return res.status(404).json({ message: "Word not found" });

//     const combined = [...entry.examples, ...newExamples];
//     const uniqueExamples = [...new Set(combined)];

//     entry.examples = uniqueExamples;
//     await entry.save();

//     return res.json({ message: "Updated", examples: entry.examples });
//   } catch (error) {
//     return res
//       .status(500)
//       .json({ message: "Update error", error: error.message });
//   }
// });
// // app.post("/knowledge/init", async (req, res) => {
// //   try {
// //     const result = await Word.updateMany(
// //       { knowledgeScore: { $exists: false } },
// //       { $set: { knowledgeScore: 0 } }
// //     );
// //     res.json({
// //       message: "knowledgeScore initialized for all users",
// //       modified: result.modifiedCount,
// //     });
// //   } catch (err) {
// //     res.status(500).json({ error: err.message });
// //   }
// // });
// app.post("/knowledge/increase", async (req, res) => {
//   const { userId, word, courseName } = req.body;

//   if (!userId || !word || !courseName) {
//     return res.status(400).json({ error: "Missing required fields" });
//   }

//   try {
//     await Word.updateOne({ userId, courseName, word }, [
//       {
//         $set: {
//           knowledgeScore: {
//             $min: [{ $add: ["$knowledgeScore", 10] }, 50],
//           },
//         },
//       },
//     ]);

//     res.json({ message: "Knowledge score increased" });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// app.post("/knowledge/reset", async (req, res) => {
//   const { userId, word, courseName } = req.body;

//   if (!userId || !word || !courseName) {
//     return res.status(400).json({ error: "Missing required fields" });
//   }

//   try {
//     await Word.updateOne(
//       { userId, courseName, word },
//       { $set: { knowledgeScore: 10 } }
//     );

//     res.json({ message: "Knowledge score reset to 10" });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// app.post("/examples/delete-many", async (req, res) => {
//   const { words } = req.body;

//   if (!Array.isArray(words) || words.length === 0) {
//     return res.status(400).json({ message: "Invalid or empty word list" });
//   }

//   try {
//     const result = await WordExample.deleteMany({ word: { $in: words } });
//     res.json({
//       message: "Examples deleted",
//       deletedCount: result.deletedCount,
//     });
//   } catch (error) {
//     res.status(500).json({ message: "Deletion error", error: error.message });
//   }
// });

// // routes/repetitionRoutes.js
// // app.post("/append-history", async (req, res) => {
// //   const { userId, courseName, word, date, status } = req.body;

// //   if (!userId || !courseName || !word || !date || !status) {
// //     return res.status(400).json({ message: "Missing required fields" });
// //   }

// //   try {
// //     const updateResult = await RepetitionProgress.updateOne(
// //       { userId, courseName, word },
// //       {
// //         $push: {
// //           history: { date: new Date(date), status },
// //         },
// //       },
// //       { upsert: true }
// //     );

// //     res.status(200).json({ message: "History entry added", updateResult });
// //   } catch (err) {
// //     console.error("Error appending to history:", err);
// //     res.status(500).json({ message: "Server error" });
// //   }
// // });

// app.post("/append-history", async (req, res) => {
//   const { userId, courseName, word, date, status } = req.body;

//   // Проверка обязательных полей
//   if (!userId || !courseName || !word || !date || !status) {
//     return res.status(400).json({ message: "Missing required fields" });
//   }

//   try {
//     // Ищем, существует ли уже прогресс по слову
//     const existing = await RepetitionProgress.findOne({ userId, courseName, word });

//     if (existing) {
//       // Если есть — просто добавляем запись в history
//       existing.history.push({
//         date: new Date(date),
//         status,
//       });
//       await existing.save();
//     } else {
//       // Если нет — создаём новый документ с history
//       await RepetitionProgress.create({
//         userId,
//         courseName,
//         word,
//         history: [
//           {
//             date: new Date(date),
//             status,
//           },
//         ],
//       });
//     }

//     res.status(200).json({ message: "History updated successfully" });
//   } catch (err) {
//     console.error("Error appending to history:", err);
//     res.status(500).json({ message: "Server error" });
//   }
// });


// app.post("/manual-add", async (req, res) => {
//   const { userId, courseName, words } = req.body;

//   if (!userId || !courseName || !Array.isArray(words)) {
//     return res.status(400).json({ message: "Invalid input" });
//   }

//   try {
//     const bulkOps = words.map(({ word, history }) => ({
//       updateOne: {
//         filter: { userId, courseName, word },
//         update: { $set: { history } },
//         upsert: true,
//       },
//     }));

//     if (bulkOps.length > 0) {
//       await RepetitionProgress.bulkWrite(bulkOps);
//     }

//     res.status(200).json({ message: "Words added or updated" });
//   } catch (err) {
//     console.error("manual-add failed:", err);
//     res.status(500).json({ message: "Server error" });
//   }
// });


// // app.post("/repetition/update", async (req, res) => {
// //   const { userId, word, courseName, status } = req.body;

// //   if (!userId || !word || !courseName || !["new", "intro", "success", "fail"].includes(status)) {
// //     return res.status(400).json({ message: "Missing or invalid fields" });
// //   }

// //   try {
// //     const update = await RepetitionProgress.findOneAndUpdate(
// //       { userId, word, courseName },
// //       {
// //         $push: {
// //           history: {
// //             date: new Date(),
// //             status,
// //           },
// //         },
// //       },
// //       { new: true, upsert: true }
// //     );

// //     res.json({ message: "Progress updated", progress: update });
// //   } catch (error) {
// //     res.status(500).json({ message: "Error updating progress", error: error.message });
// //   }
// // });


// //оно есть но не надо его использовать лучше без него 
// app.post("/repetition/init-missing", async (req, res) => {
//   const { userId, courseName } = req.body;

//   if (!userId || !courseName) {
//     return res.status(400).json({ message: "Missing required fields" });
//   }

//   try {
//     const allWords = await Word.find({ userId, courseName });
//     const existing = await RepetitionProgress.find({ userId, courseName });

//     const existingKeys = new Set(
//       existing.map((e) => `${e.word}_${e.courseName}_${e.userId}`)
//     );

//     const toInsert = allWords
//       .filter((w) => !existingKeys.has(`${w.word}_${w.courseName}_${userId}`))
//       .map((w) => ({
//         userId,
//         courseName,
//         word: w.word,
//         history: [{ date: new Date(), status: "new" }],
//       }));

//     if (toInsert.length > 0) {
//       try {
//         await RepetitionProgress.insertMany(toInsert, { ordered: false });
//       } catch (err) {
//         if (err.code !== 11000) {
//           return res.status(500).json({ message: "Insert error", error: err.message });
//         }
//       }
//     }

//     res.json({ inserted: toInsert.length });
//   } catch (error) {
//     res.status(500).json({ message: "Error initializing repetition", error: error.message });
//   }
// });


// app.get("/repetition/:userId/:courseName", async (req, res) => {
//   const { userId, courseName } = req.params;

//   try {
//     const data = await RepetitionProgress.find({ userId, courseName });

//     if (!data || data.length === 0) {
//       return res.status(200).json({
//         success: true,
//         message: "No repetition data found for this course",
//         data: [],
//       });
//     }

//     res.status(200).json({
//       success: true,
//       message: "Repetition data loaded",
//       data,
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       message: "Error fetching repetition data",
//       error: error.message,
//     });
//   }
// });

// app.delete("/repetition/:userId/:word", async (req, res) => {
//   const { userId, word } = req.params;

//   try {
//     const deleted = await RepetitionProgress.deleteOne({ userId, word });
//     res.json({ message: "Progress deleted", deleted });
//   } catch (error) {
//     res.status(500).json({ message: "Error deleting progress", error: error.message });
//   }
// });



// // ✅ Добавь в server.js
// app.post("/translate", async (req, res) => {
//   const { texts } = req.body;

//   if (!Array.isArray(texts) || texts.length === 0) {
//     return res.status(400).json({ message: "texts must be a non-empty array" });
//   }

//   try {
//     const azureResponse = await axios.post(
//       "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=ru",
//       texts.map((text) => ({ Text: text })),
//       {
//         headers: {
//           "Ocp-Apim-Subscription-Key": process.env.AZURE_TRANSLATE_KEY,
//           "Ocp-Apim-Subscription-Region": process.env.AZURE_REGION,
//           "Content-Type": "application/json",
//         },
//       }
//     );

//     const translated = azureResponse.data.map((item) =>
//       item.translations[0].text
//     );

//     res.json({ translations: translated });
//   } catch (error) {
//     console.error("Azure Translation error:", error.message);
//     res.status(500).json({ message: "Translation failed" });
//   }
// });



// const AZURE_KEY = process.env.AZURE_TRANSLATE_KEY;
// const AZURE_REGION = process.env.AZURE_REGION;

// const headers = {
//   "Ocp-Apim-Subscription-Key": AZURE_KEY,
//   "Ocp-Apim-Subscription-Region": AZURE_REGION,
//   "Content-Type": "application/json",
// };

// app.post("/word-examples-translate", async (req, res) => {
//   const { word } = req.body;

//   if (!word) {
//     return res.status(400).json({ message: "Missing word" });
//   }

//   try {
//     // 1. Lookup — получаем переводы
//     const lookupRes = await axios.post(
//       "https://api.cognitive.microsofttranslator.com/dictionary/lookup?api-version=3.0&from=en&to=ru",
//       [{ Text: word }],
//       { headers }
//     );

//     const topTranslations = lookupRes.data?.[0]?.translations
//       ?.sort((a, b) => b.confidence - a.confidence)
//       ?.slice(0, 4)
//       ?.map((t) => t.normalizedTarget);

//     if (!topTranslations || topTranslations.length === 0) {
//       return res.status(404).json({ message: "No translations found" });
//     }

//     // 2. Examples — получаем предложения
//     const examplesRes = await axios.post(
//       "https://api.cognitive.microsofttranslator.com/dictionary/examples?api-version=3.0&from=en&to=ru",
//       topTranslations.map((t) => ({ Text: word, Translation: t })),
//       { headers }
//     );

//     const examples = examplesRes.data
//       .flatMap((item) => item.examples || [])
//       .slice(0, 3);

//     return res.json({ examples });
//   } catch (err) {
//     console.error("Word examples error:", err.message);
//     return res.status(500).json({ message: "Failed to load word examples" });
//   }
// });

// // ======= СТАРТ СЕРВЕРА =======
// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
