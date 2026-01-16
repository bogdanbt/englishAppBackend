
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

const WordAiEnrichmentSchema = new mongoose.Schema(
  {
    userId: {
  type: String,
  required: true,
  index: true,
},

    wordId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    word: {
      type: String,
      required: true,
    },

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
      },
    ],

    model: {
      type: String,
      default: "gpt-4.1-mini",
    },

    promptVersion: {
      type: String,
      default: "v1",
    },

    constraints: {
      example_level: {
        type: String,
        default: "B1",
      },
    },
    openaiCalls: { type: Number, default: 0 },
lastCallAt: { type: Date, default: null },


    error: String,
  },
  { timestamps: true }
);

// ❗ защита от дублей
WordAiEnrichmentSchema.index(
  { userId: 1, wordId: 1 },
  { unique: true }
);

const WordAiEnrichment = mongoose.model(
  "WordAiEnrichment",
  WordAiEnrichmentSchema
);



//  переделать потом под разные языки перевода сейчас только английский русский


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function enrichWordWithOpenAI(word) {
  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: `
You are an English learning assistant.

For the word "${word}", return STRICT JSON with:
- 1–3 Russian translations (simple, common)
- short usage explanation in SIMPLE English (B1 level)
- Russian translation of that explanation
- 3–4 short example sentences in English (B1 level or simpler),
  where ALL words except "${word}" are simple/common.
- Russian translations for each example.

Rules:
- Keep everything short.
- No advanced vocabulary.
- JSON only. No comments. No markdown.

JSON format:
{
  "word": "...",
  "translations": [
    { "ru": "...", "label_en": "...", "primary": true }
  ],
  "usage_en": "...",
  "usage_ru": "...",
  "examples": [
    { "en": "...", "ru": "..." }
  ]
}
    `,
  });

  const text = response.output_text;
  const parsed = JSON.parse(text);

  if (
    !parsed.translations?.length ||
    !parsed.usage_en ||
    !parsed.usage_ru ||
    !parsed.examples?.length
  ) {
    throw new Error("Invalid AI response structure");
  }

  return parsed;
}
// конец хелпера аи 


// ======= ГЕНЕРАЦИЯ ТОКЕНОВ =======
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

app.get("/ai/enrich-word/:wordId", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { wordId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(wordId)) {
      return res.status(400).json({ error: "Invalid wordId" });
    }
    const oid = new mongoose.Types.ObjectId(wordId);

    const enrichment = await WordAiEnrichment.findOne({ userId, wordId: oid });
    if (!enrichment) return res.status(404).json({ status: "missing" });

    return res.json(enrichment);
  } catch (err) {
    console.error("AI enrich GET error:", err);
    res.status(500).json({ error: "Server error" });
  }
});
app.post("/ai/enrich-word", authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const { wordId } = req.body || {};

  // 0) валидация входа (чтобы не было CastError -> 500)
  if (!wordId) return res.status(400).json({ error: "wordId required" });
  if (!mongoose.Types.ObjectId.isValid(wordId)) {
    return res.status(400).json({ error: "Invalid wordId" });
  }
  const oid = new mongoose.Types.ObjectId(wordId);

  try {
    // 1) проверить, что слово вообще существует у этого пользователя
    const wordDoc = await Word.findOne({ _id: oid, userId }).lean();
    if (!wordDoc) return res.status(404).json({ error: "Word not found" });

    // 2) если уже готово — вернуть сразу (0 платных вызовов)
    const existing = await WordAiEnrichment.findOne({ userId, wordId: oid });
    if (existing?.status === "ready") return res.json(existing);

    // 3) атомарно "захватить" генерацию: только один запрос становится владельцем
    //    - если уже processing -> этот запрос не владелец и вернёт 202
    let claimed = null;
    try {
      claimed = await WordAiEnrichment.findOneAndUpdate(
        { userId, wordId: oid, status: { $ne: "processing" } },
        {
  $setOnInsert: { userId, wordId: oid, word: wordDoc.word },
  $set: { status: "processing", error: null, lastCallAt: new Date() },
  $inc: { openaiCalls: 1 },
},

        { new: true, upsert: true }
      );
    } catch (e) {
      // если гонка на upsert/unique index — не владелец
      if (e?.code === 11000) {
        return res.status(202).json({ status: "processing" });
      }
      throw e;
    }

    // если doc уже был processing — мы не владелец, просто скажем "processing"
    if (!claimed || claimed.status !== "processing") {
      return res.status(202).json({ status: "processing" });
    }

    // 4) мы владелец -> единственный платный вызов
    const aiData = await enrichWordWithOpenAI(wordDoc.word);

    // 5) сохранить результат
    const updated = await WordAiEnrichment.findOneAndUpdate(
      { userId, wordId: oid },
      {
        $set: {
          translations: aiData.translations || [],
          usage_en: aiData.usage_en || "",
          usage_ru: aiData.usage_ru || "",
          examples: aiData.examples || [],
          status: "ready",
          error: null,
        },
      },
      { new: true }
    );

    return res.json(updated);
  } catch (err) {
    console.error("AI enrich POST error:", err);

    // пометить failed (но аккуратно, без CastError)
    try {
      await WordAiEnrichment.findOneAndUpdate(
        { userId, wordId: oid },
        { $set: { status: "failed", error: err?.message || "Enrichment failed" } },
        { new: true }
      );
    } catch {}

    return res.status(500).json({ error: "Server error" });
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
