require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Credentials, Translator } = require("@translated/lara");
const {
  initDatabase,
  findTranslationsByKeys,
  insertTranslations,
  makeBackendKey,
} = require("./db");

const app = express();
const PORT = process.env.PORT || 10000;

const credentials = new Credentials(
  process.env.LARA_ACCESS_KEY_ID,
  process.env.LARA_ACCESS_KEY_SECRET
);
const lara = new Translator(credentials);

app.use(express.json());

app.use(
  cors({
    origin: "*",
  })
);

app.post("/translate", async (req, res) => {
  try {
    const { sourceLang, targetLang, sentences } = req.body;

    if (
      typeof sourceLang !== "string" ||
      typeof targetLang !== "string" ||
      !Array.isArray(sentences) ||
      sentences.length === 0 ||
      !sentences.every((s) => typeof s === "string")
    ) {
      return res.status(400).json({ error: "Invalid request body" });
    }

    const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
    if (totalChars > 8000) {
      return res
        .status(400)
        .json({ error: "Request too large (over 8000 characters)" });
    }

    const keys = sentences.map((text) =>
      makeBackendKey(sourceLang, targetLang, text)
    );

    const existingRows = await findTranslationsByKeys(keys);
    const existingMap = new Map();
    existingRows.forEach((row) => {
      existingMap.set(row.key, row.translated_text);
    });

    const translations = new Array(sentences.length).fill(null);
    const toLookupForLara = [];

    keys.forEach((key, index) => {
      const cached = existingMap.get(key);
      if (cached) {
        translations[index] = cached;
      } else {
        toLookupForLara.push({ index, text: sentences[index], key });
      }
    });

    const cacheHits = sentences.length - toLookupForLara.length;
    console.log(
      `Cache: ${cacheHits} hits, ${toLookupForLara.length} misses (${sentences.length} total)`
    );

    if (toLookupForLara.length > 0) {
      const textsForLara = toLookupForLara.map((item) => item.text);

      const result = await lara.translate(textsForLara, sourceLang, targetLang);

      if (!Array.isArray(result.translation)) {
        return res.status(500).json({ error: "Unexpected Lara response shape" });
      }

      const newTranslations = result.translation;

      if (newTranslations.length !== textsForLara.length) {
        console.error(
          "Length mismatch from Lara",
          textsForLara.length,
          newTranslations.length
        );
        return res
          .status(500)
          .json({ error: "Translation length mismatch" });
      }

      const rowsToInsert = [];
      newTranslations.forEach((tl, i) => {
        const { index, key } = toLookupForLara[i];
        translations[index] = tl;
        rowsToInsert.push({
          key,
          source_lang: sourceLang,
          target_lang: targetLang,
          original_text: sentences[index],
          translated_text: tl,
        });
      });

      await insertTranslations(rowsToInsert);
    }

    return res.json({ translations });
  } catch (err) {
    console.error("Internal /translate error", err);

    if (err.constructor.name === "LaraApiError") {
      return res.status(502).json({
        error: "Upstream translation error",
        details: err.message,
      });
    }

    return res.status(500).json({ error: "Internal server error" });
  }
});

async function startServer() {
  try {
    if (process.env.DATABASE_URL) {
      console.log("Initializing database...");
      await initDatabase();
      console.log("Database ready");
    } else {
      console.warn(
        "WARNING: DATABASE_URL not set - running without cache (will use Lara for every request)"
      );
    }

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
