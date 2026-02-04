require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Credentials, Translator } = require("@translated/lara");

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

    const result = await lara.translate(sentences, sourceLang, targetLang);

    if (!Array.isArray(result.translation)) {
      return res.status(500).json({ error: "Unexpected Lara response shape" });
    }

    const translations = result.translation;

    if (translations.length !== sentences.length) {
      console.error(
        "Length mismatch",
        sentences.length,
        translations.length
      );
      return res
        .status(500)
        .json({ error: "Translation length mismatch" });
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
