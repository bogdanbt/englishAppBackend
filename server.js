import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import OpenAI from "openai";
import { createEmptyCard, fsrs, Rating } from "ts-fsrs";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const LESSON_MINUTES = Number(process.env.LESSON_MINUTES || 5);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const corsOrigin = !process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === "*"
  ? true
  : process.env.CORS_ORIGIN.split(",").map((s) => s.trim());

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const scheduler = fsrs();

/* =========================================================
   MONGOOSE SCHEMAS
   ========================================================= */

const exampleSchema = new mongoose.Schema(
  {
    en: { type: String, required: true },
    ru: { type: String, required: true },
  },
  { _id: false }
);

const practiceSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, default: "cloze" },
    en: { type: String, required: true },
    ru: { type: String, required: true },
    answer: { type: [String], required: true, default: [] },
  },
  { _id: false }
);
const learningItemSchema = new mongoose.Schema(
  {
    rawInput: { type: String, required: true, unique: true },

    // what user originally meant
    sourceHint: { type: String, default: "" },
    sourceAnswerMarker: { type: String, default: "" },

    // actual learning card
    item: { type: String, required: true },
    translate: { type: String, required: true },
    type: { type: String, enum: ["word", "phrase"], required: true },

    // phrase notes (optional)
    sourceNote: { type: String, default: "" }, // what user typed after note:
    note: { type: String, default: "" },       // final note shown in app

    meaning: { type: String, required: true },
    meaningRu: { type: String, required: true },
    examples: { type: [exampleSchema], default: [] },
    practice: { type: [practiceSchema], required: true },

    // first-time intro logic
    introSeen: { type: Boolean, default: false },

    // FSRS scheduling
    fsrsCard: { type: mongoose.Schema.Types.Mixed, default: () => createEmptyCard() },
    due: { type: Date, default: () => new Date() },

    // analytics / debug
    totalReviews: { type: Number, default: 0 },
    lastReviewedAt: { type: Date, default: null },
    lastRating: { type: Number, default: null },
    lastHintCount: { type: Number, default: 0 },
    lastResult: { type: String, enum: ["correct", "wrong", null], default: null },
  },
  { timestamps: true }
);

// IMPORTANT: index for schedule queries
learningItemSchema.index({ due: 1, createdAt: 1 });

const lessonSessionSchema = new mongoose.Schema(
  {
    startedAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    seenItemIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "LearningItem" }],
    isFinished: { type: Boolean, default: false },

    currentItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LearningItem",
      default: null,
    },
    currentMode: {
      type: String,
      default: null, // "learn" | "practice"
    },
    currentPracticeIndex: {
      type: Number,
      default: null,
    },
  },
  { timestamps: true }
);

const LearningItem = mongoose.model("LearningItem", learningItemSchema);
const LessonSession = mongoose.model("LessonSession", lessonSessionSchema);

/* =========================================================
   HELPERS
   ========================================================= */

function splitRawUnits(rawText) {
  return String(rawText || "")
    .replace(/\r/g, "")
    .split(/\n|;|·/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitAnswerToArray(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// function parseRawUnit(rawUnit) {
//   const rawInput = String(rawUnit).trim();

//   // captures "text(marker)" where marker is the LAST (...) block
//   const match = rawInput.match(/^(.*?)\s*\(([^()]*)\)\s*$/);

//   if (!match) {
//     return {
//       rawInput,
//       item: rawInput,
//       type: "word",
//       hint: "",
//       answerMarker: "",
//       answerParts: splitAnswerToArray(rawInput),
//     };
//   }

//   const item = match[1].trim();
//   const marker = match[2].trim();

//   if (marker.toLowerCase().startsWith("answer:")) {
//     const answerMarker = marker.slice(marker.indexOf(":") + 1).trim();

//     return {
//       rawInput,
//       item,
//       type: "phrase",
//       hint: "",
//       answerMarker,
//       answerParts: splitAnswerToArray(answerMarker),
//     };
//   }

//   return {
//     rawInput,
//     item,
//     type: "word",
//     hint: marker,
//     answerMarker: "",
//     answerParts: splitAnswerToArray(item),
//   };
// }

function parseRawUnit(rawUnit) {
  const rawInput = String(rawUnit).trim();

  // captures "text(marker)" where marker is the LAST (...) block
  const match = rawInput.match(/^(.*?)\s*\(([^()]*)\)\s*$/);

  if (!match) {
    return {
      rawInput,
      item: rawInput,
      type: "word",
      hint: "",
      answerMarker: "",
      answerParts: splitAnswerToArray(rawInput),
      note: "",
    };
  }

  const item = match[1].trim();
  const markerRaw = match[2].trim();
  const markerLower = markerRaw.toLowerCase();

  // If marker contains answer:, treat as phrase (and allow note:)
  if (markerLower.includes("answer:")) {
    const parts = markerRaw
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean);

    let answerMarker = "";
    let note = "";

    for (const p of parts) {
      const low = p.toLowerCase();
      if (low.startsWith("answer:")) {
        answerMarker = p.slice(p.indexOf(":") + 1).trim();
      } else if (low.startsWith("note:")) {
        note = p.slice(p.indexOf(":") + 1).trim();
      }
    }

    return {
      rawInput,
      item,
      type: "phrase",
      hint: "",
      answerMarker,
      answerParts: splitAnswerToArray(answerMarker),
      note, // <-- важно
    };
  }

  // Otherwise: word with hint in brackets
  return {
    rawInput,
    item,
    type: "word",
    hint: markerRaw,
    answerMarker: "",
    answerParts: splitAnswerToArray(item),
    note: "",
  };
}

function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[’]/g, "'")
    .replace(/[.,!?;:]+$/g, "")
    .replace(/\s+/g, " ");
}

function answersMatch(expected, received) {
  if (!Array.isArray(expected) || !Array.isArray(received)) return false;
  if (expected.length !== received.length) return false;

  return expected.every((part, index) => normalizeToken(part) === normalizeToken(received[index]));
}

function calculateAppRating(isCorrect, hintCount) {
  if (!isCorrect) return 1;
  if (hintCount === 0) return 4;
  if (hintCount === 1) return 3;
  if (hintCount === 2) return 2;
  return 1;
}

function toFsrsRating(appRating) {
  switch (appRating) {
    case 1:
      return Rating.Again;
    case 2:
      return Rating.Hard;
    case 3:
      return Rating.Good;
    case 4:
      return Rating.Easy;
    default:
      return Rating.Again;
  }
}

function hydrateFsrsCard(card) {
  const empty = createEmptyCard();
  const source = card || {};

  return {
    ...empty,
    ...source,
    due: source?.due ? new Date(source.due) : empty.due,
    last_review: source?.last_review ? new Date(source.last_review) : empty.last_review,
  };
}

function extractResponseText(response) {
  if (response?.output_text) return response.output_text;

  const chunks = [];
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && content?.text) {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("").trim();
}
function ensureLessonExists(lesson) {
  if (!lesson) {
    const error = new Error("Lesson not found");
    error.status = 404;
    throw error;
  }
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

async function markAlreadyKnown(item) {
  const now = new Date();
  const targetDue = addDays(now, 7);

  // Сохраняем FSRS-логику (как "Easy"), но насильно ставим due = +7 дней (KISS и соответствует требованию)
  const currentCard = hydrateFsrsCard(item.fsrsCard);
  const result = scheduler.next(currentCard, now, Rating.Easy);

  result.card.due = targetDue;

  item.fsrsCard = result.card;
  item.due = targetDue;

  item.introSeen = true;

  item.totalReviews += 1;
  item.lastReviewedAt = now;
  item.lastRating = 4;
  item.lastHintCount = 0;
  item.lastResult = "correct";

  await item.save();

  return { nextDue: item.due };
}
function isLessonExpired(lesson) {
  return new Date() > new Date(lesson.endsAt);
}

function clearCurrentCard(lesson) {
  lesson.currentItemId = null;
  lesson.currentMode = null;
  lesson.currentPracticeIndex = null;
}

function pickRandomPracticeIndex(item) {
  if (!Array.isArray(item?.practice) || item.practice.length === 0) {
    return 0;
  }

  return Math.floor(Math.random() * item.practice.length);
}

function buildLearnCardResponse(item) {
  const previewPractice = item.practice?.[0] || null;

  return {
    status: "ok",
    mode: "learn",
    card: {
      id: item._id,
      item: item.item,
      type: item.type,
      translate: item.translate,
      meaning: item.meaning,
      meaningRu: item.meaningRu,
      note: item.note || "",
      examples: item.examples,
      practicePreview: previewPractice
        ? {
            answer: previewPractice.answer,
            firstLetters: previewPractice.answer.map((part) => part[0] || ""),
          }
        : null,
    },
  };
}

function buildPracticeCardResponse(item, practiceIndex) {
  const practice = item.practice?.[practiceIndex];

  if (!practice) {
    const error = new Error("Practice block missing");
    error.status = 400;
    throw error;
  }

  return {
    status: "ok",
    mode: "practice",
    card: {
      id: item._id,
      item: item.item,
      type: item.type,
      translate: item.translate,
      note: item.note || "",
      practiceIndex,
      practice: {
        type: practice.type,
        en: practice.en,
        ru: practice.ru,
        answer: practice.answer,
        firstLetters: practice.answer.map((part) => part[0] || ""),
      },
    },
  };
}
function buildLearningItemSchema(itemType) {
  const isWord = itemType === "word";

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      item: { type: "string" },
      translate: { type: "string" },
      type: { type: "string", enum: ["word", "phrase"] },
      meaning: { type: "string" },
      meaningRu: { type: "string" },

      examples: {
        type: "array",
        minItems: isWord ? 2 : 0,
        maxItems: isWord ? 2 : 0,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            en: { type: "string" },
            ru: { type: "string" },
          },
          required: ["en", "ru"],
        },
      },

      practice: {
        type: "array",
        minItems: isWord ? 2 : 1,
        maxItems: isWord ? 2 : 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["cloze"] },
            en: { type: "string" },
            ru: { type: "string" },
            answer: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["type", "en", "ru", "answer"],
        },
      },
    },
    required: ["item", "translate", "type", "meaning", "meaningRu", "examples", "practice"],
  };
}
async function generateGrammarNote(phraseText, answerParts) {
  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      {
        role: "user",
        content: `You are an English grammar tutor.
Given:
- sentence: "${phraseText}"
- target answer tokens: ${JSON.stringify(answerParts)}

Return ONLY JSON:
{ "note": "<short Russian note (1-2 sentences) explaining what grammar is practiced here. Simple words.>" }`,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "grammar_note",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { note: { type: "string" } },
          required: ["note"],
        },
      },
    },
  });

  const raw = extractResponseText(response);
  const data = JSON.parse(raw);
  return String(data.note || "").trim();
}
async function resolveHint(item, hint) {
  if (!hint) return null;

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      {
        role: "user",
        content: `The user wants to learn the English word or phrase "${item}" with this hint: "${hint}"
The hint describes which specific meaning or usage they want. It can be anything: an abbreviation, a Russian word, a grammatical note, or free text. The hint may be approximate or misspelled — interpret what the user most likely intended.
Return ONLY a JSON object, no markdown:
{
  "translate": "<the most natural, colloquial Russian equivalent — 
  the word a native Russian speaker would actually use. 
  One or two words maximum. NOT a literal translation, 
  but the closest natural word.>",
  "meaning": "<English definition matching this exact meaning, 5-10 words>",
  "meaningRu": "<same definition in Russian>",
  "constraint": "<one sentence in English: what this word must mean in the generated card>"
}`,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "hint_resolution",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            translate: { type: "string" },
            meaning: { type: "string" },
            meaningRu: { type: "string" },
            constraint: { type: "string" },
          },
          required: ["translate", "meaning", "meaningRu", "constraint"],
        },
      },
    },
  });

  const raw = extractResponseText(response);
  return JSON.parse(raw);
}


async function generateLearningDoc(parsedUnit) {
  const schema = buildLearningItemSchema(parsedUnit.type);
  let rawText = "";

  // Resolve hint into concrete semantic constraint before main generation
  const resolved = parsedUnit.hint ? await resolveHint(parsedUnit.item, parsedUnit.hint) : null;

  try {
    const systemPrompt = `
You create English -> Russian study cards for a spaced repetition app.

Return JSON only.

Hard rules:
1. item must stay EXACTLY as provided by the user.
2. type must stay EXACTLY as provided by the user.
3. If the user provided a hint in brackets, it is a HARD restriction, not a suggestion.
4. practice.en must contain blanks "_____" only in place of the answer tokens.
5. practice.ru must ALWAYS be a full Russian translation of the whole sentence, with NO blanks, NO underscores, NO omissions.
6. answer must EXACTLY match the supplied answer array.
7. No markdown. No explanations. JSON only.

Rules for type="word":
8. examples must contain EXACTLY 2 items.
9. practice must contain EXACTLY 2 cloze items.
10. The target meaning must follow the user hint exactly.

Rules for type="phrase":
11. examples must be [].
12. practice must contain EXACTLY 1 cloze item.
13. Blank ONLY the supplied answer tokens.
`.trim();

   const userPrompt =
      parsedUnit.type === "word"
        ? `
${resolved ? `SEMANTIC LOCK — every field must strictly follow this resolved meaning:
- translate (use exactly this value): "${resolved.translate}"
- meaning (use exactly this value): "${resolved.meaning}"
- meaningRu (use exactly this value): "${resolved.meaningRu}"
- constraint: ${resolved.constraint}
Do NOT use any other meaning of "${parsedUnit.item}". The fields translate/meaning/meaningRu are already resolved — copy them exactly.
` : ""}
Input:
- item: "${parsedUnit.item}"
- type: "word"
- exact answer array: ${JSON.stringify(parsedUnit.answerParts)}

Task:
Create one learning document for this word.

Important:
- practice.ru must always be the full Russian translation without blanks.
- examples = exactly 2
- practice = exactly 2
`.trim()
        : `
Input:
- item: "${parsedUnit.item}"
- type: "phrase"
- exact answer array: ${JSON.stringify(parsedUnit.answerParts)}

Task:
Create one learning document for this phrase.

Important:
- examples must be []
- practice must contain exactly 1 cloze item
- Blank ONLY these answer tokens: ${JSON.stringify(parsedUnit.answerParts)}
- practice.ru must be the full Russian translation of the whole sentence without blanks
`.trim();

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "learning_item",
          strict: true,
          schema,
        },
      },
    });

    rawText = extractResponseText(response);

    if (!rawText) {
      const error = new Error("OpenAI returned empty response");
      error.gptRaw = null;
      throw error;
    }

    let doc;
    try {
      doc = JSON.parse(rawText);
    } catch {
      const error = new Error("OpenAI returned invalid JSON");
      error.gptRaw = rawText;
      throw error;
    }

    if (!doc?.practice?.length) {
      const error = new Error("OpenAI did not return practice");
      error.gptRaw = rawText;
      throw error;
    }

    doc.item = parsedUnit.item;
    doc.type = parsedUnit.type;
    // If hint was resolved, lock these fields to the resolved values
    doc.translate = resolved ? resolved.translate : String(doc.translate || "").trim();
    doc.meaning = resolved ? resolved.meaning : String(doc.meaning || "").trim();
    doc.meaningRu = resolved ? resolved.meaningRu : String(doc.meaningRu || "").trim();

    doc.examples = Array.isArray(doc.examples)
      ? doc.examples.map((x) => ({
          en: String(x.en || "").trim(),
          ru: String(x.ru || "").trim(),
        }))
      : [];

    doc.practice = Array.isArray(doc.practice)
      ? doc.practice.map((p) => ({
          type: "cloze",
          en: String(p.en || "").trim(),
          ru: String(p.ru || "").trim(),
          answer: [...parsedUnit.answerParts],
        }))
      : [];

    for (const p of doc.practice) {
      if (!p.ru || p.ru.includes("_____")) {
        const error = new Error("practice.ru must be full Russian translation without blanks");
        error.gptRaw = rawText;
        throw error;
      }
    }

    if (parsedUnit.type === "word") {
      if (doc.examples.length !== 2) {
        const error = new Error("word must have exactly 2 examples");
        error.gptRaw = rawText;
        throw error;
      }
      if (doc.practice.length !== 2) {
        const error = new Error("word must have exactly 2 practice items");
        error.gptRaw = rawText;
        throw error;
      }
    }

    if (parsedUnit.type === "phrase") {
      if (doc.examples.length !== 0) {
        const error = new Error("phrase must not have examples");
        error.gptRaw = rawText;
        throw error;
      }
      if (doc.practice.length !== 1) {
        const error = new Error("phrase must have exactly 1 practice item");
        error.gptRaw = rawText;
        throw error;
      }
    }

    return {
      rawInput: parsedUnit.rawInput,
      sourceHint: parsedUnit.hint || "",
      sourceAnswerMarker: parsedUnit.answerMarker || "",
      item: doc.item,
      translate: doc.translate,
      type: doc.type,
      meaning: doc.meaning,
      meaningRu: doc.meaningRu,
      examples: doc.examples,
      practice: doc.practice,
    };
  } catch (error) {
    if (!error.gptRaw && rawText) {
      error.gptRaw = rawText;
    }
    throw error;
  }
}
async function reviewAndReschedule(item, appRating, hintCount, isCorrect) {
  const now = new Date();
  const currentCard = hydrateFsrsCard(item.fsrsCard);
  const result = scheduler.next(currentCard, now, toFsrsRating(appRating));

  item.fsrsCard = result.card;
  item.due = result.card.due;
  item.introSeen = true;
  item.totalReviews += 1;
  item.lastReviewedAt = now;
  item.lastRating = appRating;
  item.lastHintCount = hintCount;
  item.lastResult = isCorrect ? "correct" : "wrong";

  await item.save();

  return {
    nextDue: item.due,
    fsrsCard: item.fsrsCard,
  };
}

/* =========================================================
   ROUTES
   ========================================================= */

// Simple health check
app.get("/api/health", async (_req, res) => {
  const itemCount = await LearningItem.countDocuments();
  res.json({
    ok: true,
    model: OPENAI_MODEL,
    lessonMinutes: LESSON_MINUTES,
    items: itemCount,
  });
});

// Import raw user input and create one Mongo document per learning unit
app.post("/api/items/import", async (req, res) => {
  try {
    const rawText = String(req.body?.rawText || "").trim();

    if (!rawText) {
      return res.status(400).json({ error: "rawText is required" });
    }

    const units = splitRawUnits(rawText);
    if (!units.length) {
      return res.status(400).json({ error: "No units found" });
    }

    const results = [];

    for (const rawUnit of units) {
      try {
        const existing = await LearningItem.findOne({ rawInput: rawUnit }).lean();
        if (existing) {
          results.push({
            rawInput: rawUnit,
            status: "skipped",
            reason: "already exists",
            id: existing._id,
          });
          continue;
        }

        const parsedUnit = parseRawUnit(rawUnit);

        if (parsedUnit.type === "phrase" && (!parsedUnit.answerParts || parsedUnit.answerParts.length === 0)) {
          results.push({
            rawInput: rawUnit,
            status: "error",
            error: 'Phrase must include "answer: ..." inside brackets',
          });
          continue;
        }

        const generated = await generateLearningDoc(parsedUnit);

        // phrase notes
        let sourceNote = "";
        let note = "";

        if (parsedUnit.type === "phrase") {
          sourceNote = String(parsedUnit.note || "").trim();

          if (!sourceNote) {
            note = "";
          } else if (sourceNote.toLowerCase() === "ai generate") {
            note = await generateGrammarNote(parsedUnit.item, parsedUnit.answerParts);
          } else {
            note = sourceNote;
          }
        }

        const saved = await LearningItem.create({
          ...generated,
          sourceNote,
          note,
          fsrsCard: createEmptyCard(),
          due: new Date(),
          introSeen: false,
        });

        results.push({
          rawInput: rawUnit,
          status: "created",
          id: saved._id,
          item: saved.item,
          type: saved.type,
        });
      } catch (error) {
        console.error("IMPORT_ITEM_FAILED", {
          rawInput: rawUnit,
          error: error.message,
          gptRaw: error.gptRaw || null,
        });

        results.push({
          rawInput: rawUnit,
          status: "error",
          error: error.message,
          gptRaw: error.gptRaw || null,
        });
      }
    }

    res.json({
      total: units.length,
      created: results.filter((x) => x.status === "created").length,
      skipped: results.filter((x) => x.status === "skipped").length,
      failed: results.filter((x) => x.status === "error").length,
      results,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Import failed" });
  }
});

// List items so the frontend can inspect what is in DB
app.get("/api/items", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);

    const sortMode = String(req.query.sort || "").toLowerCase(); // "" | "due"
    const horizonMinutes = Math.min(Number(req.query.horizonMinutes || 0), 60 * 24 * 7); // max 7 days

    const now = new Date();
    const filter = {};

    if (horizonMinutes > 0) {
      const to = new Date(now.getTime() + horizonMinutes * 60 * 1000);
      filter.due = { $lte: to };
    }

    const sort =
      sortMode === "due"
        ? { due: 1, createdAt: 1 }
        : { createdAt: -1 };

    const items = await LearningItem.find(filter).sort(sort).limit(limit).lean();
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load items" });
  }
});
// Start a 5-minute lesson session
app.post("/api/lessons/start", async (_req, res) => {
  try {
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + LESSON_MINUTES * 60 * 1000);

    const lesson = await LessonSession.create({
      startedAt,
      endsAt,
      seenItemIds: [],
      isFinished: false,
      currentItemId: null,
      currentMode: null,
      currentPracticeIndex: null,
    });

    const dueCount = await LearningItem.countDocuments({
      due: { $lte: startedAt },
    });

    res.json({
      lessonId: lesson._id,
      startedAt,
      endsAt,
      dueCount,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to start lesson" });
  }
});

// Get next due card for this lesson
app.get("/api/lessons/:lessonId/next", async (req, res) => {
  try {
    const lesson = await LessonSession.findById(req.params.lessonId);
    ensureLessonExists(lesson);

    // Если карточка уже активна, возвращаем ее снова.
    if (lesson.currentItemId) {
      const currentItem = await LearningItem.findById(lesson.currentItemId);

      if (!currentItem) {
        clearCurrentCard(lesson);
        await lesson.save();
      } else if (lesson.currentMode === "learn") {
        return res.json(buildLearnCardResponse(currentItem));
      } else if (lesson.currentMode === "practice") {
        return res.json(
          buildPracticeCardResponse(currentItem, lesson.currentPracticeIndex ?? 0)
        );
      }
    }

    // Если время вышло и активной карточки уже нет, урок закончен.
    if (lesson.isFinished || isLessonExpired(lesson)) {
      lesson.isFinished = true;
      clearCurrentCard(lesson);
      await lesson.save();

      return res.json({
        status: "finished",
        reason: "time_over",
        message: "5 minutes are over. Good job. See you later.",
      });
    }

    const now = new Date();

    const item = await LearningItem.findOne({
      due: { $lte: now },
      _id: { $nin: lesson.seenItemIds },
    }).sort({ due: 1, createdAt: 1 });

    if (!item) {
      lesson.isFinished = true;
      clearCurrentCard(lesson);
      await lesson.save();

      return res.json({
        status: "finished",
        reason: "no_due_cards_left",
      });
    }

    lesson.seenItemIds.push(item._id);
    lesson.currentItemId = item._id;

    if (!item.introSeen) {
      lesson.currentMode = "learn";
      lesson.currentPracticeIndex = null;
      await lesson.save();

      return res.json(buildLearnCardResponse(item));
    }

    const practiceIndex = pickRandomPracticeIndex(item);
    lesson.currentMode = "practice";
    lesson.currentPracticeIndex = practiceIndex;
    await lesson.save();

    return res.json(buildPracticeCardResponse(item, practiceIndex));
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || "Failed to get next card",
    });
  }
});

// Mark first intro screen as completed
// MVP choice: this counts as a "Good" first exposure in FSRS
// Mark first intro screen as completed
// Supports "alreadyKnown": push due at least +7 days
app.post("/api/lessons/:lessonId/items/:itemId/complete-intro", async (req, res) => {
  try {
    const lesson = await LessonSession.findById(req.params.lessonId);
    ensureLessonExists(lesson);

    if (lesson.isFinished && !lesson.currentItemId) {
      return res.status(400).json({
        error: "Lesson is finished",
        lessonFinished: true,
      });
    }

    if (!lesson.currentItemId || String(lesson.currentItemId) !== req.params.itemId) {
      return res.status(400).json({
        error: "This item is not the current active card",
      });
    }

    if (lesson.currentMode !== "learn") {
      return res.status(400).json({
        error: "Current card is not in learn mode",
      });
    }

    const item = await LearningItem.findById(req.params.itemId);
    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }

    const alreadyKnown = Boolean(req.body?.alreadyKnown);

    let nextDue = item.due;
    let rating = 3;

    if (alreadyKnown) {
      // KISS: “я уже знаю” => гарантированно показать не раньше чем через 7 дней
      const now = new Date();
      const minDue = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      // Обновим FSRS как Easy, но due принудительно минимум +7 дней
      const currentCard = hydrateFsrsCard(item.fsrsCard);
      const result = scheduler.next(currentCard, now, Rating.Easy);

      result.card.due = minDue;

      item.fsrsCard = result.card;
      item.due = minDue;

      item.introSeen = true;
      item.totalReviews += 1;
      item.lastReviewedAt = now;
      item.lastRating = 4;
      item.lastHintCount = 0;
      item.lastResult = "correct";

      await item.save();

      nextDue = item.due;
      rating = 4;
    } else {
      // Обычный сценарий: первое знакомство засчитываем как "Good"
      if (!item.introSeen) {
        const result = await reviewAndReschedule(item, 3, 0, true);
        nextDue = result.nextDue;
      }
    }

    clearCurrentCard(lesson);

    if (isLessonExpired(lesson)) {
      lesson.isFinished = true;
    }

    await lesson.save();

    res.json({
      ok: true,
      introSeen: true,
      alreadyKnown,
      rating,
      nextDue,
      lessonFinished: lesson.isFinished,
      message: lesson.isFinished ? "5 minutes are over. Good job. See you later." : null,
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || "Failed to complete intro",
    });
  }
});
app.delete("/api/items/:itemId", async (req, res) => {
  try {
    const deleted = await LearningItem.findByIdAndDelete(req.params.itemId);
    if (!deleted) return res.status(404).json({ error: "Item not found" });

    res.json({ ok: true, deletedId: req.params.itemId });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to delete item" });
  }
});
// Submit user answer for cloze card
app.post("/api/lessons/:lessonId/items/:itemId/answer", async (req, res) => {
  try {
    const lesson = await LessonSession.findById(req.params.lessonId);
    ensureLessonExists(lesson);

    if (lesson.isFinished && !lesson.currentItemId) {
      return res.status(400).json({
        error: "Lesson is finished",
        lessonFinished: true,
      });
    }

    if (!lesson.currentItemId || String(lesson.currentItemId) !== req.params.itemId) {
      return res.status(400).json({
        error: "This item is not the current active card",
      });
    }

    if (lesson.currentMode !== "practice") {
      return res.status(400).json({
        error: "Current card is not in practice mode",
      });
    }

    const item = await LearningItem.findById(req.params.itemId);
    if (!item) {
      return res.status(404).json({ error: "Item not found" });
    }

    const practiceIndex = lesson.currentPracticeIndex ?? 0;
    const practice = item.practice?.[practiceIndex];

    if (!practice) {
      return res.status(400).json({ error: "Practice block missing" });
    }

    const rawAnswers = Array.isArray(req.body?.answers)
      ? req.body.answers
      : req.body?.answers != null
        ? [req.body.answers]
        : [];

    const answers = rawAnswers.map((x) => String(x || "").trim());
    const hintCount = Math.max(0, Number(req.body?.hintCount || 0));

    const isCorrect = answersMatch(practice.answer, answers);

    if (!isCorrect) {
      return res.json({
        ok: true,
        correct: false,
        locked: true,
        message: "Keep trying",
      });
    }

    const appRating = calculateAppRating(true, hintCount);
    const result = await reviewAndReschedule(item, appRating, hintCount, true);

    clearCurrentCard(lesson);

    if (isLessonExpired(lesson)) {
      lesson.isFinished = true;
    }

    await lesson.save();

    res.json({
      ok: true,
      correct: true,
      rating: appRating,
      hintCount,
      nextDue: result.nextDue,
      lessonFinished: lesson.isFinished,
      message: lesson.isFinished
        ? "5 minutes are over. Good job. See you later."
        : null,
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || "Failed to submit answer",
    });
  }
});

/* =========================================================
   STARTUP
   ========================================================= */

async function start() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing in .env");
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing in .env");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  app.listen(PORT, () => {
    console.log(`API started on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});