
require("dotenv").config();
const OpenAI = require("openai");

const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const googleTTS = require("google-tts-api");
const axios = require("axios");
const app = express();
app.use(express.json());
app.use(cookieParser());

app.use(
  cors({
    origin: ["http://localhost:3000", "https://englishtarapp.netlify.app"],
    credentials: true,
  })
);

mongoose.connect(process.env.MONGO_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// ======= МОДЕЛЬ ПОЛЬЗОВАТЕЛЯ =======
const UserSchema = new mongoose.Schema({
  id: { type: String, default: uuidv4, unique: true }, // Генерируем UUID автоматически
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: "user" },
  refreshTokens: [String],
});
const User = mongoose.model("User", UserSchema);

// ======= МОДЕЛЬ ДЕФОЛТНЫХ СЛОВ=======
const defaultWordSchema = new mongoose.Schema({
  courseName: { type: String, required: true }, // Название курса
  lessonName: { type: String, required: true }, // Название урока
  word: { type: String, required: true }, // Слово
  translation: { type: String, required: true }, // Перевод
});

const DefaultWord = mongoose.model("DefaultWord", defaultWordSchema);
// ======= МОДЕЛЬ ДАННЫХ СЛОВ ПОЛЬЗОВАТЕЛЯ=======
const wordSchema = new mongoose.Schema({
  userId: { type: String, required: true }, // ID пользователя
  courseName: { type: String, required: true }, // Название курса
  lessonName: { type: String, required: true }, // Название урока
  word: { type: String, required: true }, // Слово
  knowledgeScore: { type: Number, default: 0 },
  translation: { type: String, required: true }, // Перевод
  repeats: { type: Number, default: 0 }, // Количество повторений
});

// ======= МОДЕЛЬ ДАННЫХ граматических предложений ПОЛЬЗОВАТЕЛЯ=======
const grammarSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  courseGrammarName: { type: String, required: true },
  lessonGrammarName: { type: String, required: true },
  sentenceGrammar: { type: String, required: true },
  translation: { type: String, required: true },
  extraWords: { type: [String], default: [] },
  rules: { type: String },
  repeats: { type: Number, default: 0 },
});
const Grammar = mongoose.model("Grammar", grammarSchema); // 👈 Вот этого не хватает!

// ======= МОДЕЛЬ ПРОГРЕССА УРОКА =======
const lessonProgressSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  courseName: { type: String, required: true },
  lessonName: { type: String, required: true },
  repeats: { type: Number, default: 0 },
});
const LessonProgress = mongoose.model("LessonProgress", lessonProgressSchema);

// ======= МОДЕЛЬ примеров использования слов =======
const exampleSchema = new mongoose.Schema({
  word: { type: String, required: true, unique: true }, // Одно слово
  examples: { type: [String], required: true }, // Примеры
  createdAt: { type: Date, default: Date.now },
});

const WordExample = mongoose.model("WordExample", exampleSchema);

// ======= МОДЕЛЬ Повтора слов в вокабуляр =======
const repetitionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  word: { type: String, required: true },
  courseName: { type: String, required: true },
  history: [
    {
      date: { type: Date, required: true },
      status: {
        type: String,
        enum: ["new", "intro", "success", "fail"],
        required: true,
      },
    },
  ],
});
repetitionSchema.index({ userId: 1, word: 1, courseName: 1 }, { unique: true });
const RepetitionProgress = mongoose.model("RepetitionProgress", repetitionSchema);

// ======= МОДЕЛЬ ПРОГРЕССА граматики =======
const grammarProgressSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  courseGrammarName: { type: String, required: true },
  lessonGrammarName: { type: String, required: true },
  repeats: { type: Number, default: 0 },
});

const GrammarProgress = mongoose.model(
  "GrammarProgress",
  grammarProgressSchema
);

const Word = mongoose.model("Word", wordSchema);


// ===== AI ENRICHMENT FOR VOCABULARY WORDS =====

// ===== GLOBAL AI ENRICHMENT CACHE (shared for all users) =====
const GlobalWordEnrichmentSchema = new mongoose.Schema(
  {
    word: { type: String, required: true, unique: true, index: true },

    status: {
      type: String,
      enum: ["missing", "processing", "ready", "failed"],
      default: "missing",
      index: true,
    },

    translations: [
      {
        ru: String,
        label_en: String,
        primary: Boolean,
      },
    ],

    usage_en: String,
    usage_ru: String,

    examples: [
      {
        en: String,
        ru: String,
        target: String,
      },
    ],

    forms: [
      {
        form: String,
        note_ru: String,
      },
    ],

    avoid_ru: { type: String, default: null },

    near_synonyms: [
      {
        word: String,
        note_ru: String,
      },
    ],

    model: { type: String, default: "gpt-4.1-mini" },

    openaiCalls: { type: Number, default: 0 },
    lastCallAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

const GlobalWordEnrichment = mongoose.model(
  "GlobalWordEnrichment",
  GlobalWordEnrichmentSchema
);




//  переделать потом под разные языки перевода сейчас только английский русский


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// async function enrichWordWithOpenAI(word) {
//   const response = await openai.responses.create({
//     model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
//     input: `
// You are helping a Russian-speaking learner master English vocabulary for real workplace usage (office / meetings / delivery / stakeholders). Keep it simple (B1), practical, not slang.

// Return STRICT JSON only for the base word: "${word}"

// HARD REQUIREMENTS:
// 1) translations: 1–3 Russian translations. One must be primary=true. Use label_en like "common" or "formal" (short).
// 2) usage_en: 1 short sentence in simple English (B1) describing when to use it.
// 3) usage_ru: Russian version of usage_en (1 short sentence).
// 4) examples: Provide 3 short examples. Workplace tone, but not jargon-heavy.
//    Each example must include:
//    - en
//    - ru
//    - target: the exact word form used in the sentence (may differ from "${word}")
//    The target must appear exactly once in "en".

// Always include these fields with strict types:
// - avoid_ru: MUST be either null or a short Russian string (no empty string).
// - near_synonyms: MUST be an array (0–2 items). Never null.
// - forms: MUST be an array (0–5 items). Never null.

// Fill rules:
// - avoid_ru: use null unless there is a common real confusion.
// - near_synonyms: include only if it prevents confusion; otherwise [].
// - forms: include only non-obvious forms (irregular or tricky inflections); otherwise [].
// - Important: Do NOT invent forms/synonyms. If unsure, return [] or null.

// Output contract:
// - The output must be a single JSON object (not an array).
// - All keys from JSON FORMAT must be present (even if null or []).
// - Do not include any extra keys.
// - All string values must be non-empty after trimming (except avoid_ru can be null).


// Style:
// - Prefer shorter sentences, but clarity beats shortness.
// - No markdown.
// - JSON only.

// JSON FORMAT:
// {
//   "word": "${word}",
//   "translations": [
//     { "ru": "...", "label_en": "common", "primary": true }
//   ],
//   "usage_en": "...",
//   "usage_ru": "...",
//   "examples": [
//     { "en": "...", "ru": "...", "target": "..." }
//   ],
//   "avoid_ru": null,
//   "near_synonyms": [],
//   "forms": []
// }
// `,

// //     input: `
// // You are helping a Russian-speaking learner master English vocabulary for real workplace usage (office / meetings / delivery / stakeholders). Keep it simple (B1), practical, not slang.

// // Return STRICT JSON only for the base word: "${word}"

// // HARD REQUIREMENTS:
// // - Provide 3 examples.
// // - Each example must include:
// //   - "en" short and natural
// //   - "ru" translation
// //   - "target": the exact word form used in the sentence (may differ from "${word}")
// //   - The target must appear exactly once in "en".
// // - Provide "usage_ru": when to use this word (1–2 short sentences in Russian).

// // OPTIONAL (only if truly helpful, otherwise use null or empty array):
// // - "avoid_ru": when NOT to use it / typical wrong situation (only if a common confusion exists).
// // - "near_synonyms": 0–2 similar words with short difference in Russian (only if it prevents confusion).
// // - "forms": list ONLY non-obvious forms that matter for this word (e.g., irregular past like go→went; or denies vs deny; otherwise empty).

// // Style:
// // - Examples should sound like normal work conversation, but not jargon-heavy.
// // - Prefer shorter sentences, but clarity beats shortness.
// // - No markdown.

// // JSON FORMAT:
// // {
// //   "word": "${word}",
// //   "usage_ru": "...",
// //   "avoid_ru": null,
// //   "near_synonyms": [],
// //   "forms": [],
// //   "examples": [
// //     { "en": "...", "ru": "...", "target": "..." }
// //   ]
// // }
// // `,

//   });

//   const text = String(response.output_text || "").trim();

//   console.log("=== AI RAW RESPONSE START ===");
//   console.log(text);
//   console.log("=== AI RAW RESPONSE END ===");

//   // 1) убираем markdown code fences если модель вдруг их дала
//   const jsonText = text.startsWith("```")
//     ? text.replace(/```json|```/g, "").trim()
//     : text;

//   let parsed;
//   try {
//     parsed = JSON.parse(jsonText);
//       // 2) AI не должен менять базовое слово
//   if (
//     !parsed?.word ||
//     String(parsed.word).trim().toLowerCase() !== String(word).trim().toLowerCase()
//   ) {
//     throw new Error("Invalid AI response: word mismatch");
//   }

//   } catch (e) {
//     throw new Error("AI response is not valid JSON (parse failed)");
//   }

//   // 3) нормализуем optional поля чтобы не падать на null/""/не тот тип
//   parsed.avoid_ru =
//     parsed.avoid_ru && String(parsed.avoid_ru).trim()
//       ? String(parsed.avoid_ru).trim()
//       : null;

//   parsed.near_synonyms = Array.isArray(parsed.near_synonyms)
//     ? parsed.near_synonyms
//     : [];

//   parsed.forms = Array.isArray(parsed.forms) ? parsed.forms : [];

//   // нормализуем строки внутри
//   parsed.usage_en = String(parsed.usage_en || "").trim();
//   parsed.usage_ru = String(parsed.usage_ru || "").trim();


//  // translations обязательны
// if (!Array.isArray(parsed.translations) || parsed.translations.length < 1) {
//   throw new Error("Invalid AI response: translations missing");
// }
// if (
//   !parsed.translations.some(
//     (t) =>
//       t &&
//       t.primary === true &&
//       typeof t.ru === "string" &&
//       t.ru.trim().length > 0 &&
//       typeof t.label_en === "string" &&
//       t.label_en.trim().length > 0
//   )
// ) {
//   throw new Error("Invalid AI response: one translation must be primary (ru + label_en required)");
// }


// // usage_en/usage_ru обязательны
// if (!parsed.usage_en || !String(parsed.usage_en).trim()) {
//   throw new Error("Invalid AI response: usage_en missing");
// }
// if (!parsed.usage_ru || !String(parsed.usage_ru).trim()) {
//   throw new Error("Invalid AI response: usage_ru missing");
// }

// // examples обязательны + target обязателен
// if (!Array.isArray(parsed.examples) || parsed.examples.length < 3) {
//   throw new Error("Invalid AI response: examples missing");
// }


//   const norm = (s) =>
//     String(s)
//       .toLowerCase()
//       .replace(/[“”]/g, '"')
//       .replace(/[^a-z0-9' ]+/g, " ") // сносит пунктуацию
//       .replace(/\s+/g, " ")
//       .trim();

//   const enTokens = norm(ex.en).split(" ");
//   const targetToken = norm(ex.target);

//   const count = enTokens.filter((t) => t === targetToken).length;

//   if (count !== 1) {
//     throw new Error(
//       `Invalid AI response: target "${ex.target}" must appear exactly once in "${ex.en}"`
//     );
//   }



//   return parsed;
// }
// конец хелпера аи 


// ======= ГЕНЕРАЦИЯ ТОКЕНОВ =======
// async function enrichWordWithOpenAI(word) {
//   const response = await openai.responses.create({
//     model: process.env.OPENAI_MODEL || "gpt-4o-mini",

//     // ✅ НАСТОЯЩАЯ JSON-АРХИТЕКТУРА
//     text: {
//       format: {
//         type: "json_schema",
//         strict: true,
//         name: "word_enrichment",
//         schema: {
//           type: "object",
//           additionalProperties: false,
//           required: [
//             "word",
//             "translations",
//             "usage_en",
//             "usage_ru",
//             "examples",
//             "avoid_ru",
//             "near_synonyms",
//             "forms",
//           ],
//           properties: {
//             word: { type: "string" },

//             translations: {
//               type: "array",
//               minItems: 1,
//               maxItems: 3,
//               items: {
//                 type: "object",
//                 additionalProperties: false,
//                 required: ["ru", "label_en", "primary"],
//                 properties: {
//                   ru: { type: "string" },
//                   label_en: { type: "string" },
//                   primary: { type: "boolean" },
//                 },
//               },
//             },

//             usage_en: { type: "string" },
//             usage_ru: { type: "string" },

//             examples: {
//               type: "array",
//               minItems: 3,
//               maxItems: 3,
//               items: {
//                 type: "object",
//                 additionalProperties: false,
//                 required: ["en", "ru", "target"],
//                 properties: {
//                   en: { type: "string" },
//                   ru: { type: "string" },
//                   target: { type: "string" },
//                 },
//               },
//             },

//             avoid_ru: {
//               anyOf: [{ type: "string" }, { type: "null" }],
//             },

//             near_synonyms: {
//               type: "array",
//               maxItems: 2,
//               items: {
//                 type: "object",
//                 additionalProperties: false,
//                 required: ["word", "note_ru"],
//                 properties: {
//                   word: { type: "string" },
//                   note_ru: { type: "string" },
//                 },
//               },
//             },

//             forms: {
//               type: "array",
//               maxItems: 5,
//               items: {
//                 type: "object",
//                 additionalProperties: false,
//                 required: ["form", "note_ru"],
//                 properties: {
//                   form: { type: "string" },
//                   note_ru: { type: "string" },
//                 },
//               },
//             },
//           },
//         },
//       },
//     },

//     // ⬇️ ПРОМПТ ПО СМЫСЛУ ТОТ ЖЕ, ЧТО У ТЕБЯ
//     input: `
// You are helping a Russian-speaking learner master English vocabulary for real workplace usage
// (office / meetings / delivery / stakeholders). Keep it simple (B1), practical, not slang.

// Base word: "${word}"

// HARD REQUIREMENTS:
// 1) translations: 1–3 Russian translations. One must be primary=true.
// 2) usage_en: 1 short B1 sentence describing when to use the word.
// 3) usage_ru: Russian version of usage_en.
// 4) examples: Exactly 3 short workplace examples.
//    Each example must include:
//    - en
//    - ru
//    - target (exact form used in en, appears exactly once).

// Rules:
// - Always return all fields defined in the schema.
// - avoid_ru: null unless there is a real common confusion.
// - near_synonyms/forms: include only if truly necessary, otherwise [].
// - Do NOT invent information. If unsure, return null or [].
// - No markdown. JSON only.
// `,
//   });
//   console.log("AI output_parsed =", response?.output_parsed);


//   // ✅ ГОТОВЫЙ ОБЪЕКТ, НЕ ТЕКСТ
//   const parsed = response.output_parsed;

//   // --- минимальная бизнес-валидация ---
//   // if (parsed.word.toLowerCase() !== word.toLowerCase()) {
//   //   throw new Error("AI response word mismatch");
//   // }

//   if (!parsed.translations.some((t) => t.primary === true)) {
//     throw new Error("Primary translation missing");
//   }

//   // проверка target (устойчивая)
//   const norm = (s) =>
//     String(s)
//       .toLowerCase()
//       .replace(/[^a-z0-9' ]+/g, " ")
//       .replace(/\s+/g, " ")
//       .trim();

//   for (const ex of parsed.examples) {
//     const tokens = norm(ex.en).split(" ");
//     const target = norm(ex.target);
//     if (tokens.filter((t) => t === target).length !== 1) {
//       throw new Error(`Target "${ex.target}" must appear exactly once`);
//     }
//   }

//   return parsed;
// }

async function enrichWordWithOpenAI(word, reqId = "no-id") {
  const DEBUG_AI = true;
  const tag = `[${reqId}]`;

  if (DEBUG_AI) {
    console.log(`${tag} AI enrich start`, { word });
  }

  let response;
  try {
    response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      text: {
        format: {
          type: "json_schema",
          strict: true,
          name: "word_enrichment",
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "word",
              "translations",
              "usage_en",
              "usage_ru",
              "examples",
              "avoid_ru",
              "near_synonyms",
              "forms",
            ],
            properties: {
              word: { type: "string" },
              translations: {
                type: "array",
                minItems: 1,
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["ru", "label_en", "primary"],
                  properties: {
                    ru: { type: "string" },
                    label_en: { type: "string" },
                    primary: { type: "boolean" },
                  },
                },
              },
              usage_en: { type: "string" },
              usage_ru: { type: "string" },
              examples: {
                type: "array",
                minItems: 3,
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["en", "ru", "target"],
                  properties: {
                    en: { type: "string" },
                    ru: { type: "string" },
                    target: { type: "string" },
                  },
                },
              },
              avoid_ru: { anyOf: [{ type: "string" }, { type: "null" }] },
              near_synonyms: {
                type: "array",
                maxItems: 2,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["word", "note_ru"],
                  properties: {
                    word: { type: "string" },
                    note_ru: { type: "string" },
                  },
                },
              },
              forms: {
                type: "array",
                maxItems: 5,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["form", "note_ru"],
                  properties: {
                    form: { type: "string" },
                    note_ru: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },

      input: `
Base word: "${word}"
Return JSON only.
`,
    });
  } catch (e) {
    console.error(`${tag} OpenAI call failed`, { word, err: e?.message, stack: e?.stack });
    throw e;
  }

  // Лог сырого ответа (ключевое, чтобы понять почему output_parsed = undefined)
  if (DEBUG_AI) {
    const text = String(response?.output_text || "");
    console.log(`${tag} AI raw`, {
      has_output_parsed: !!response?.output_parsed,
      output_text_len: text.length,
      output_text_head: text.slice(0, 1200), // не больше ~1200 символов
      usage: response?.usage, // если есть
    });
  }

  const safeJsonParse = (t) => {
    const raw = String(t || "").trim();
    if (!raw) return null;
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  };

  const parsed = response?.output_parsed ?? safeJsonParse(response?.output_text);

  if (!parsed || typeof parsed !== "object") {
    console.error(`${tag} AI parse failed`, {
      word,
      output_parsed: response?.output_parsed,
      output_text_head: String(response?.output_text || "").slice(0, 1200),
    });
    throw new Error("AI response is not valid JSON (no parsed output)");
  }

  // минимальная валидация
  if (!Array.isArray(parsed.translations) || parsed.translations.length < 1) {
    throw new Error("Invalid AI response: translations missing");
  }
  if (!parsed.translations.some((t) => t && t.primary === true)) {
    throw new Error("Primary translation missing");
  }
  if (!Array.isArray(parsed.examples) || parsed.examples.length !== 3) {
    throw new Error("Invalid AI response: examples missing");
  }

  // Лог результата после парса
  if (DEBUG_AI) {
    console.log(`${tag} AI parsed ok`, {
      word: parsed.word,
      translationsCount: parsed.translations?.length,
      examplesCount: parsed.examples?.length,
    });
  }

  // target должен встретиться ровно 1 раз
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  for (const ex of parsed.examples) {
    const tokens = norm(ex.en).split(" ");
    const target = norm(ex.target);
    if (tokens.filter((t) => t === target).length !== 1) {
      throw new Error(`Target "${ex.target}" must appear exactly once`);
    }
  }

  return parsed;
}


const generateAccessToken = (user) => {
  return jwt.sign(
    { userId: user.id, role: user.role }, // Используем `user.id`
    process.env.ACCESS_SECRET,
    { expiresIn: "15m" }
  );
};



const generateRefreshToken = (user) => {
  return jwt.sign({ userId: user.id }, process.env.REFRESH_SECRET, {
    expiresIn: "14d",
  });
};

// ======= РЕГИСТРАЦИЯ =======
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      email,
      password: hashedPassword,
      refreshTokens: [],
    });

    await user.save();
    res.status(201).json({ message: "User registered", userId: user.id });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error registering user", error: error.message });
  }
});

// ======= ЛОГИН =======
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  // ✅ Добавляем `refreshToken` в массив
  user.refreshTokens.push(refreshToken);
  await user.save();

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
  });

  res.json({ accessToken });
});

// ======= ОБНОВЛЕНИЕ ТОКЕНОВ =======
app.post("/auth/refresh", async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken) return res.sendStatus(401);

  try {
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_SECRET);
    const user = await User.findOne({
      id: decoded.userId,
      refreshTokens: { $in: [refreshToken] },
    });

    if (!user) {
      return res.sendStatus(403);
    }

    // ✅ Удаляем старый `refreshToken`
    user.refreshTokens = user.refreshTokens.filter(
      (token) => token !== refreshToken
    );

    // ✅ Генерируем новый `refreshToken`
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    // ✅ Добавляем новый `refreshToken` в массив
    user.refreshTokens.push(newRefreshToken);
    await user.save();

    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    });

    res.json({ accessToken: newAccessToken });
  } catch {
    res.sendStatus(403);
  }
});

// ======= ВЫХОД (LOGOUT) =======
app.post("/auth/logout", async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken) return res.sendStatus(204);

  // ✅ Поиск пользователя, у которого есть этот refreshToken
  const user = await User.findOne({ refreshTokens: { $in: [refreshToken] } });

  if (user) {
    user.refreshTokens = user.refreshTokens.filter(
      (token) => token !== refreshToken
    );
    await user.save();
  }

  res.clearCookie("refreshToken");
  res.sendStatus(204);
});

// ======= ПРОТЕКТИРОВАННЫЙ ЭНДПОИНТ =======
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.sendStatus(401);
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(token, process.env.ACCESS_SECRET, (err, decoded) => {
    if (err) return res.sendStatus(403);
    req.user = decoded;
    next();
  });
};

app.get("/protected", authMiddleware, (req, res) => {
  res.json({ message: "This is a protected route", user: req.user });
});

// ======= ЭНДПОИНТ =======

// app.post("/words", async (req, res) => {
//   try {
//     const { userId, courseName, lessonName, word, translation } = req.body;

//     const newWord = new Word({
//       userId,
//       courseName,
//       lessonName,
//       word,
//       translation,
//       repeats: 0,
//     });

//     await newWord.save();
//     res.status(201).json({ message: "Word added", word: newWord });
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error adding word", error: error.message });
//   }
// });




// ===== AI WORD ENRICHMENT ENDPOINT =====

// ===== GLOBAL AI WORD ENRICHMENT ENDPOINTS (shared cache) =====

// GET: проверить кеш (готово/нет) по слову
app.get("/ai/enrich-word", async (req, res) => {
  try {
    const raw = (req.query.word || "").toString();
    const word = raw.trim().toLowerCase();

    if (!word) return res.status(400).json({ error: "word query param required" });
    if (word.length > 64) return res.status(400).json({ error: "word too long" });

    const enrichment = await GlobalWordEnrichment.findOne({ word }).lean();
    if (!enrichment) return res.status(404).json({ status: "missing" });

    return res.json(enrichment);
  } catch (err) {
    console.error("GLOBAL AI enrich GET error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST: если нет кеша — вызвать OpenAI, сохранить, вернуть
app.post("/ai/enrich-word", async (req, res) => {
  try {
    const raw = (req.body?.word || "").toString();
    const word = raw.trim().toLowerCase();

    if (!word) return res.status(400).json({ error: "word required" });
    if (word.length > 64) return res.status(400).json({ error: "word too long" });

    // 1) если уже готово — вернуть сразу
    const existing = await GlobalWordEnrichment.findOne({ word });
    if (existing?.status === "ready") return res.json(existing);

    // 2) атомарно "захватить" генерацию (чтобы не было 10 параллельных OpenAI вызовов)
    let claimed;
    try {
      claimed = await GlobalWordEnrichment.findOneAndUpdate(
        { word, status: { $ne: "processing" } },
        {
          $setOnInsert: { word },
          $set: { status: "processing", error: null, lastCallAt: new Date() },
          $inc: { openaiCalls: 1 },
        },
        { new: true, upsert: true }
      );
    } catch (e) {
      // гонка на unique word
      if (e?.code === 11000) {
        return res.status(202).json({ status: "processing" });
      }
      throw e;
    }

    if (!claimed || claimed.status !== "processing") {
      return res.status(202).json({ status: "processing" });
    }

    // 3) единственный платный вызов
    console.log("CALL AI (GLOBAL) word=", word);
    const aiData = await enrichWordWithOpenAI(word);

    // 4) сохранить результат
    const updated = await GlobalWordEnrichment.findOneAndUpdate(
      { word },
      {
        $set: {
          translations: aiData.translations || [],
          usage_en: aiData.usage_en || "",
          usage_ru: aiData.usage_ru || "",
          examples: aiData.examples || [],
          forms: Array.isArray(aiData.forms) ? aiData.forms : [],
          avoid_ru: aiData.avoid_ru ?? null,
          near_synonyms: Array.isArray(aiData.near_synonyms) ? aiData.near_synonyms : [],
          status: "ready",
          error: null,
        },
      },
      { new: true }
    );

    return res.json(updated);
  } catch (err) {
    console.error("GLOBAL AI enrich POST error:", err);

    // попытка пометить failed (не критично если тоже упадёт)
    try {
      const raw = (req.body?.word || "").toString();
      const word = raw.trim().toLowerCase();
      if (word) {
        await GlobalWordEnrichment.findOneAndUpdate(
          { word },
          { $set: { status: "failed", error: err?.message || "Enrichment failed" } },
          { new: true }
        );
      }
    } catch {}

    return res.status(500).json({ error: err?.message || "Server error" });
  }
});



app.post("/words", async (req, res) => {
  try {
    const data = req.body;

    if (Array.isArray(data)) {
      const inserted = await Word.insertMany(data);
      return res.status(201).json({ message: "Words added", inserted });
    } else {
      const word = new Word(data);
      await word.save();
      return res.status(201).json({ message: "Word added", word });
    }
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error adding word", error: error.message });
  }
});

app.get("/words/:userId", async (req, res) => {
  try {
    const words = await Word.find({ userId: req.params.userId });
    res.json(words);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching words", error: error.message });
  }
});
app.get("/courses/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // Получаем уникальные названия курсов пользователя
    const courses = await Word.distinct("courseName", { userId });

    res.json({ courses });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching courses", error: error.message });
  }
});
app.get("/lessons/:userId/:courseName", async (req, res) => {
  try {
    const { userId, courseName } = req.params;

    // Получаем уникальные названия уроков пользователя в данном курсе
    const lessons = await Word.distinct("lessonName", { userId, courseName });

    res.json({ lessons });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Ошибка получения уроков", error: error.message });
  }
});

app.post("/load-defaults", async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    // ✅ Проверяем, загружены ли уже слова
    const existingWords = await Word.findOne({ userId });
    if (existingWords) {
      return res
        .status(400)
        .json({ message: "Words already loaded for this user" });
    }

    const defaultWords = await DefaultWord.find();
    if (!defaultWords.length) {
      return res.status(404).json({ message: "No default words found" });
    }

   const userWords = defaultWords.map((w) => ({
  userId,
  courseName: w.courseName,
  lessonName: w.lessonName,
  word: w.word,
  translation: w.translation,
  repeats: 0,
}));

const inserted = await Word.insertMany(userWords);
res.status(201).json({ message: "Courses and words loaded", words: inserted });

  } catch (error) {
    res
      .status(500)
      .json({ message: "Error loading defaults", error: error.message });
  }
});

app.get("/words/:userId/:courseName/:lessonName", async (req, res) => {
  try {
    const words = await Word.find({
      userId: req.params.userId,
      courseName: req.params.courseName,
      lessonName: req.params.lessonName,
    });
    res.json(words);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error fetching words", error: error.message });
  }
});

app.post("/admin/words", async (req, res) => {
  try {
    const insertedWords = await DefaultWord.insertMany(req.body);
    res
      .status(201)
      .json({ message: "Default words uploaded", words: insertedWords });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error uploading default words", error: error.message });
  }
});

app.post("/lesson-progress", async (req, res) => {
  try {
    const { userId, courseName, lessonName } = req.body;

    const existing = await LessonProgress.findOne({
      userId,
      courseName,
      lessonName,
    });
    if (existing) {
      return res
        .status(400)
        .json({ message: "Progress already exists for this lesson" });
    }

    const progress = new LessonProgress({ userId, courseName, lessonName });
    await progress.save();
    res.status(201).json({ message: "Lesson progress created", progress });
  } catch (error) {
    res.status(500).json({
      message: "Error creating lesson progress",
      error: error.message,
    });
  }
});

// исползовать для обнуления ведь этот ендпоинт просто сохраняет число
app.put("/lesson-progress", async (req, res) => {
  try {
    const { userId, courseName, lessonName, repeats } = req.body;

    const progress = await LessonProgress.findOneAndUpdate(
      { userId, courseName, lessonName },
      { repeats },
      { new: true }
    );

    if (!progress) {
      return res.status(404).json({ message: "Progress not found" });
    }

    res.json({ message: "Repeats updated", progress });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error updating repeats", error: error.message });
  }
});

// использовать для увеличения повторов на +1 если записи нет то ее создаем
app.patch("/lesson-progress/increment", async (req, res) => {
  try {
    const { userId, courseName, lessonName } = req.body;

    const progress = await LessonProgress.findOneAndUpdate(
      { userId, courseName, lessonName },
      { $inc: { repeats: 1 } },
      {
        new: true,
        upsert: true, // создаёт запись, если её нет
        setDefaultsOnInsert: true, // если ты используешь default-поля в схеме
      }
    );

    res.json({ message: "Repeats incremented or created", progress });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error incrementing repeats", error: error.message });
  }
});

app.get("/lesson-progress/:userId/:courseName", async (req, res) => {
  try {
    const { userId, courseName } = req.params;
    const progress = await LessonProgress.find({ userId, courseName });
    res.json(progress);
  } catch (error) {
    res.status(500).json({
      message: "Error fetching lesson progress",
      error: error.message,
    });
  }
});

app.get("/speak/:word", async (req, res) => {
  const { word } = req.params;

  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
      word
    )}&tl=en-us&client=tw-ob`;

    const response = await axios.get(url, {
      responseType: "stream",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
    });

    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Disposition": `inline; filename="${word}.mp3"`,
    });

    response.data.pipe(res);
  } catch (error) {
    console.error("Ошибка при получении озвучки:", error.message);
    res.status(500).json({ message: "Error generating speech" });
  }
});

//======grammar
// получить все курсы грамматики
app.get("/grammar-courses/:userId", async (req, res) => {
  try {
    const courses = await Grammar.distinct("courseGrammarName", {
      userId: req.params.userId,
    });
    res.json({ courses });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching grammar courses",
      error: error.message,
    });
  }
});

// получить уроки внутри курса
app.get("/grammar-lessons/:userId/:courseGrammarName", async (req, res) => {
  try {
    const lessons = await Grammar.distinct("lessonGrammarName", {
      userId: req.params.userId,
      courseGrammarName: req.params.courseGrammarName,
    });
    res.json({ lessons });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching grammar lessons",
      error: error.message,
    });
  }
});

// получить предложения внутри урока
app.get(
  "/grammar/:userId/:courseGrammarName/:lessonGrammarName",
  async (req, res) => {
    try {
      const items = await Grammar.find({
        userId: req.params.userId,
        courseGrammarName: req.params.courseGrammarName,
        lessonGrammarName: req.params.lessonGrammarName,
      });
      res.json(items);
    } catch (error) {
      res.status(500).json({
        message: "Error fetching grammar items",
        error: error.message,
      });
    }
  }
);

// добавить предложение добавлял только одно предложение за запрос
// app.post("/grammar", async (req, res) => {
//   try {
//     const grammar = new Grammar(req.body);
//     await grammar.save();
//     res.status(201).json({ message: "Grammar entry saved", grammar });
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Error saving grammar", error: error.message });
//   }
// });

app.post("/grammar", async (req, res) => {
  try {
    const data = req.body;

    if (Array.isArray(data)) {
      const inserted = await Grammar.insertMany(data);
      return res
        .status(201)
        .json({ message: "Grammar entries saved", inserted });
    } else {
      const grammar = new Grammar(data);
      await grammar.save();
      return res.status(201).json({ message: "Grammar entry saved", grammar });
    }
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error saving grammar", error: error.message });
  }
});

app.patch("/grammar-progress/increment", async (req, res) => {
  try {
    const { userId, courseGrammarName, lessonGrammarName } = req.body;

    const progress = await GrammarProgress.findOneAndUpdate(
      { userId, courseGrammarName, lessonGrammarName },
      { $inc: { repeats: 1 } },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    res.json({ message: "Grammar progress updated", progress });
  } catch (error) {
    res.status(500).json({
      message: "Error updating grammar progress",
      error: error.message,
    });
  }
});

app.get("/grammar-progress/:userId/:courseGrammarName", async (req, res) => {
  try {
    const { userId, courseGrammarName } = req.params;

    const progress = await GrammarProgress.find({ userId, courseGrammarName });
    res.json(progress);
  } catch (error) {
    res.status(500).json({
      message: "Error fetching grammar progress",
      error: error.message,
    });
  }
});
app.put("/grammar-progress", async (req, res) => {
  try {
    const { userId, courseGrammarName, lessonGrammarName, repeats } = req.body;

    const progress = await GrammarProgress.findOneAndUpdate(
      { userId, courseGrammarName, lessonGrammarName },
      { repeats },
      { new: true }
    );

    if (!progress) {
      return res.status(404).json({ message: "Progress not found" });
    }

    res.json({ message: "Repeats reset successfully", progress });
  } catch (error) {
    res.status(500).json({
      message: "Error resetting grammar progress",
      error: error.message,
    });
  }
});
app.put("/grammar/:id", async (req, res) => {
  try {
    const updated = await Grammar.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });

    if (!updated) {
      return res.status(404).json({ message: "Sentence not found" });
    }

    res.json({ message: "Sentence updated", updated });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error updating sentence", error: error.message });
  }
});
app.delete(
  "/grammar/:userId/:courseGrammarName/:lessonGrammarName",
  async (req, res) => {
    try {
      const { userId, courseGrammarName, lessonGrammarName } = req.params;
      const result = await Grammar.deleteMany({
        userId,
        courseGrammarName,
        lessonGrammarName,
      });

      // Также удалить прогресс:
      await GrammarProgress.deleteOne({
        userId,
        courseGrammarName,
        lessonGrammarName,
      });

      res.json({
        message: "Lesson deleted",
        deletedCount: result.deletedCount,
      });
    } catch (error) {
      res
        .status(500)
        .json({ message: "Error deleting lesson", error: error.message });
    }
  }
);
app.get("/words/:userId/:courseName", async (req, res) => {
  try {
    const { userId, courseName } = req.params;
    const words = await Word.find({ userId, courseName });

    res.status(200).json({
      success: true,
      message: "Words loaded for course",
      data: words,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching words",
      error: error.message,
    });
  }
});

app.delete("/words/:userId/:courseName/:lessonName", async (req, res) => {
  try {
    const { userId, courseName, lessonName } = req.params;
    const result = await Word.deleteMany({
      userId,
      courseName,
      lessonName,
    });

    // Также можно удалить LessonProgress:
    await LessonProgress.deleteOne({
      userId,
      courseName,
      lessonName,
    });

    res.json({ message: "Lesson deleted", deletedCount: result.deletedCount });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting lesson", error: error.message });
  }
});

app.post("/examples", async (req, res) => {
  const data = req.body;
  if (!data) return res.status(400).json({ message: "No data provided" });

  const items = Array.isArray(data) ? data : [data];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item.word || !Array.isArray(item.examples)) {
      skipped++;
      continue;
    }

    try {
      const existing = await WordExample.findOne({ word: item.word });

      if (existing) {
        const combined = [...existing.examples, ...item.examples];
        const uniqueExamples = [...new Set(combined)];
        if (uniqueExamples.length !== existing.examples.length) {
          existing.examples = uniqueExamples;
          await existing.save();
          updated++;
        } else {
          skipped++;
        }
      } else {
        await WordExample.create({
          word: item.word,
          examples: [...new Set(item.examples)],
        });
        inserted++;
      }
    } catch (error) {
      console.error(`Error processing word "${item.word}":`, error.message);
      skipped++;
    }
  }

  return res.status(200).json({ inserted, updated, skipped });
});

app.get("/examples/:word", async (req, res) => {
  try {
    const example = await WordExample.findOne({ word: req.params.word });
    if (!example) return res.status(404).json({ message: "Not found" });
    return res.json(example);
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Fetch error", error: error.message });
  }
});

app.put("/examples/:word", async (req, res) => {
  const newExamples = req.body.examples;

  if (!Array.isArray(newExamples)) {
    return res.status(400).json({ message: "examples must be an array" });
  }

  try {
    const entry = await WordExample.findOne({ word: req.params.word });
    if (!entry) return res.status(404).json({ message: "Word not found" });

    const combined = [...entry.examples, ...newExamples];
    const uniqueExamples = [...new Set(combined)];

    entry.examples = uniqueExamples;
    await entry.save();

    return res.json({ message: "Updated", examples: entry.examples });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Update error", error: error.message });
  }
});
// app.post("/knowledge/init", async (req, res) => {
//   try {
//     const result = await Word.updateMany(
//       { knowledgeScore: { $exists: false } },
//       { $set: { knowledgeScore: 0 } }
//     );
//     res.json({
//       message: "knowledgeScore initialized for all users",
//       modified: result.modifiedCount,
//     });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });
app.post("/knowledge/increase", async (req, res) => {
  const { userId, word, courseName } = req.body;

  if (!userId || !word || !courseName) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await Word.updateOne({ userId, courseName, word }, [
      {
        $set: {
          knowledgeScore: {
            $min: [{ $add: ["$knowledgeScore", 10] }, 50],
          },
        },
      },
    ]);

    res.json({ message: "Knowledge score increased" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/knowledge/reset", async (req, res) => {
  const { userId, word, courseName } = req.body;

  if (!userId || !word || !courseName) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await Word.updateOne(
      { userId, courseName, word },
      { $set: { knowledgeScore: 10 } }
    );

    res.json({ message: "Knowledge score reset to 10" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/examples/delete-many", async (req, res) => {
  const { words } = req.body;

  if (!Array.isArray(words) || words.length === 0) {
    return res.status(400).json({ message: "Invalid or empty word list" });
  }

  try {
    const result = await WordExample.deleteMany({ word: { $in: words } });
    res.json({
      message: "Examples deleted",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    res.status(500).json({ message: "Deletion error", error: error.message });
  }
});

// routes/repetitionRoutes.js
// app.post("/append-history", async (req, res) => {
//   const { userId, courseName, word, date, status } = req.body;

//   if (!userId || !courseName || !word || !date || !status) {
//     return res.status(400).json({ message: "Missing required fields" });
//   }

//   try {
//     const updateResult = await RepetitionProgress.updateOne(
//       { userId, courseName, word },
//       {
//         $push: {
//           history: { date: new Date(date), status },
//         },
//       },
//       { upsert: true }
//     );

//     res.status(200).json({ message: "History entry added", updateResult });
//   } catch (err) {
//     console.error("Error appending to history:", err);
//     res.status(500).json({ message: "Server error" });
//   }
// });

app.post("/append-history", async (req, res) => {
  const { userId, courseName, word, date, status } = req.body;

  // Проверка обязательных полей
  if (!userId || !courseName || !word || !date || !status) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    // Ищем, существует ли уже прогресс по слову
    const existing = await RepetitionProgress.findOne({ userId, courseName, word });

    if (existing) {
      // Если есть — просто добавляем запись в history
      existing.history.push({
        date: new Date(date),
        status,
      });
      await existing.save();
    } else {
      // Если нет — создаём новый документ с history
      await RepetitionProgress.create({
        userId,
        courseName,
        word,
        history: [
          {
            date: new Date(date),
            status,
          },
        ],
      });
    }

    res.status(200).json({ message: "History updated successfully" });
  } catch (err) {
    console.error("Error appending to history:", err);
    res.status(500).json({ message: "Server error" });
  }
});


app.post("/manual-add", async (req, res) => {
  const { userId, courseName, words } = req.body;

  if (!userId || !courseName || !Array.isArray(words)) {
    return res.status(400).json({ message: "Invalid input" });
  }

  try {
    const bulkOps = words.map(({ word, history }) => ({
      updateOne: {
        filter: { userId, courseName, word },
        update: { $set: { history } },
        upsert: true,
      },
    }));

    if (bulkOps.length > 0) {
      await RepetitionProgress.bulkWrite(bulkOps);
    }

    res.status(200).json({ message: "Words added or updated" });
  } catch (err) {
    console.error("manual-add failed:", err);
    res.status(500).json({ message: "Server error" });
  }
});


// app.post("/repetition/update", async (req, res) => {
//   const { userId, word, courseName, status } = req.body;

//   if (!userId || !word || !courseName || !["new", "intro", "success", "fail"].includes(status)) {
//     return res.status(400).json({ message: "Missing or invalid fields" });
//   }

//   try {
//     const update = await RepetitionProgress.findOneAndUpdate(
//       { userId, word, courseName },
//       {
//         $push: {
//           history: {
//             date: new Date(),
//             status,
//           },
//         },
//       },
//       { new: true, upsert: true }
//     );

//     res.json({ message: "Progress updated", progress: update });
//   } catch (error) {
//     res.status(500).json({ message: "Error updating progress", error: error.message });
//   }
// });


//оно есть но не надо его использовать лучше без него 
app.post("/repetition/init-missing", async (req, res) => {
  const { userId, courseName } = req.body;

  if (!userId || !courseName) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    const allWords = await Word.find({ userId, courseName });
    const existing = await RepetitionProgress.find({ userId, courseName });

    const existingKeys = new Set(
      existing.map((e) => `${e.word}_${e.courseName}_${e.userId}`)
    );

    const toInsert = allWords
      .filter((w) => !existingKeys.has(`${w.word}_${w.courseName}_${userId}`))
      .map((w) => ({
        userId,
        courseName,
        word: w.word,
        history: [{ date: new Date(), status: "new" }],
      }));

    if (toInsert.length > 0) {
      try {
        await RepetitionProgress.insertMany(toInsert, { ordered: false });
      } catch (err) {
        if (err.code !== 11000) {
          return res.status(500).json({ message: "Insert error", error: err.message });
        }
      }
    }

    res.json({ inserted: toInsert.length });
  } catch (error) {
    res.status(500).json({ message: "Error initializing repetition", error: error.message });
  }
});


app.get("/repetition/:userId/:courseName", async (req, res) => {
  const { userId, courseName } = req.params;

  try {
    const data = await RepetitionProgress.find({ userId, courseName });

    if (!data || data.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No repetition data found for this course",
        data: [],
      });
    }

    res.status(200).json({
      success: true,
      message: "Repetition data loaded",
      data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching repetition data",
      error: error.message,
    });
  }
});

app.delete("/repetition/:userId/:word", async (req, res) => {
  const { userId, word } = req.params;

  try {
    const deleted = await RepetitionProgress.deleteOne({ userId, word });
    res.json({ message: "Progress deleted", deleted });
  } catch (error) {
    res.status(500).json({ message: "Error deleting progress", error: error.message });
  }
});



// ✅ Добавь в server.js
app.post("/translate", async (req, res) => {
  const { texts } = req.body;

  if (!Array.isArray(texts) || texts.length === 0) {
    return res.status(400).json({ message: "texts must be a non-empty array" });
  }

  try {
    const azureResponse = await axios.post(
      "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=ru",
      texts.map((text) => ({ Text: text })),
      {
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_TRANSLATE_KEY,
          "Ocp-Apim-Subscription-Region": process.env.AZURE_REGION,
          "Content-Type": "application/json",
        },
      }
    );

    const translated = azureResponse.data.map((item) =>
      item.translations[0].text
    );

    res.json({ translations: translated });
  } catch (error) {
    console.error("Azure Translation error:", error.message);
    res.status(500).json({ message: "Translation failed" });
  }
});



const AZURE_KEY = process.env.AZURE_TRANSLATE_KEY;
const AZURE_REGION = process.env.AZURE_REGION;

const headers = {
  "Ocp-Apim-Subscription-Key": AZURE_KEY,
  "Ocp-Apim-Subscription-Region": AZURE_REGION,
  "Content-Type": "application/json",
};

app.post("/word-examples-translate", async (req, res) => {
  const { word } = req.body;

  if (!word) {
    return res.status(400).json({ message: "Missing word" });
  }

  try {
    // 1. Lookup — получаем переводы
    const lookupRes = await axios.post(
      "https://api.cognitive.microsofttranslator.com/dictionary/lookup?api-version=3.0&from=en&to=ru",
      [{ Text: word }],
      { headers }
    );

    const topTranslations = lookupRes.data?.[0]?.translations
      ?.sort((a, b) => b.confidence - a.confidence)
      ?.slice(0, 4)
      ?.map((t) => t.normalizedTarget);

    if (!topTranslations || topTranslations.length === 0) {
      return res.status(404).json({ message: "No translations found" });
    }

    // 2. Examples — получаем предложения
    const examplesRes = await axios.post(
      "https://api.cognitive.microsofttranslator.com/dictionary/examples?api-version=3.0&from=en&to=ru",
      topTranslations.map((t) => ({ Text: word, Translation: t })),
      { headers }
    );

    const examples = examplesRes.data
      .flatMap((item) => item.examples || [])
      .slice(0, 3);

    return res.json({ examples });
  } catch (err) {
    console.error("Word examples error:", err.message);
    return res.status(500).json({ message: "Failed to load word examples" });
  }
});

// ======= СТАРТ СЕРВЕРА =======
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
