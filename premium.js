// Premium + PAYG features: better voice, Zeron (AI tutor), practice exercises with
// "Explain My Mistake", "Say It Like a Filipino" and video subtitle translation.
// Every route here is limited to plan_status pre / payg / active; free users get 403 premium_required.
const crypto = require("crypto");
const express = require("express");
const axios = require("axios");

const PREMIUM_PLANS = ["pre", "payg", "active"];
const jsonBody = express.json({ limit: "200kb" });

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clampStr(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clampList(list, maxItems, mapFn) {
  return Array.isArray(list) ? list.slice(0, maxItems).map(mapFn).filter(Boolean) : [];
}

const LEVELS = ["beginner", "intermediate", "advanced"];
function normLevel(level) {
  return LEVELS.includes(level) ? level : "beginner";
}

/** Per-user sliding window limiter so one account can't hammer the LLM/TTS providers. */
function makeUserLimiter(windowMs, max) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const list = (hits.get(req.userId) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: "rate_limited" });
    list.push(now);
    hits.set(req.userId, list);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

/** Tiny LRU for synthesized audio so replaying a word or subtitle line doesn't re-bill a provider. */
class AudioCache {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(key) {
    const v = this.map.get(key);
    if (!v) return null;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, v) {
    this.map.set(key, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

// ---------------------------------------------------------------------------
// LLM (Azure OpenAI, same deployment the dictionary uses)
// ---------------------------------------------------------------------------

async function llmJson(system, user, { maxTokens = 900, temperature = 0.6, history = [] } = {}) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  if (!endpoint || !apiKey || !deployment) throw new Error("llm_not_configured");
  const messages = [{ role: "system", content: system }, ...history];
  if (user) messages.push({ role: "user", content: user });
  const response = await axios.post(
    `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-12-01-preview`,
    { messages, response_format: { type: "json_object" }, max_tokens: maxTokens, temperature },
    { headers: { "api-key": apiKey, "Content-Type": "application/json" }, timeout: 30000 }
  );
  const content = response.data.choices[0].message.content;
  return { data: JSON.parse(content), outChars: content.length };
}

const TAGALOG_EXPERT =
  "You are an expert Filipino (Tagalog) teacher who grew up in Metro Manila. You know how people really talk today, " +
  "including natural Taglish code-switching, po/opo politeness, and regional nuance. Be accurate: never invent words. " +
  "Explanations are in clear, friendly English. Respond with valid JSON only, matching the requested shape exactly.";

// ---------------------------------------------------------------------------
// Voice providers. PREMIUM_TTS_PROVIDER picks the first choice (azure | elevenlabs | google);
// any failure falls back to Azure so playback never silently breaks.
// ---------------------------------------------------------------------------

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Rough English-word detector so Taglish lines can be voiced by a multilingual voice
// instead of forcing the whole line through Tagalog phonetics.
const COMMON_EN = new Set(("the a an and or but so if is are was were be been to of in on at for with from by about my your " +
  "our their his her it this that these those i you we they he she me us them can will would should could just really very " +
  "okay ok sorry please thanks thank yes no not do does did have has had going get got like love know think want need " +
  "time today tomorrow work school meeting traffic phone class office late early already actually basically anyway").split(" "));

function looksTaglish(text) {
  const words = text.toLowerCase().match(/[a-z']+/g) || [];
  if (words.length < 3) return false;
  const en = words.filter((w) => COMMON_EN.has(w)).length;
  return en / words.length >= 0.2;
}

async function azureTts(text, { gender, style, rate }) {
  if (!process.env.AZURE_SPEECH_KEY) throw new Error("azure_tts_not_configured");
  const region = process.env.AZURE_SPEECH_REGION || "eastus";
  const ratePct = `${Math.round((rate - 1) * 100)}%`;
  const safe = escapeXml(text);
  const taglish = style === "taglish" || (style === "auto" && looksTaglish(text));
  let ssml;
  if (taglish) {
    // DragonHD multilingual voices switch between English and Filipino mid-sentence naturally.
    const voice = gender === "male" ? "en-US-Andrew:DragonHDLatestNeural" : "en-US-Ava:DragonHDLatestNeural";
    ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="fil-PH"><voice name="${voice}"><lang xml:lang="fil-PH"><prosody rate="${ratePct}">${safe}</prosody></lang></voice></speak>`;
  } else {
    const voice = gender === "male" ? "fil-PH-AngeloNeural" : "fil-PH-BlessicaNeural";
    ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="fil-PH"><voice name="${voice}"><prosody rate="${ratePct}">${safe}</prosody></voice></speak>`;
  }
  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
    },
    body: ssml,
  });
  if (!response.ok) throw new Error(`azure_tts_${response.status}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

async function elevenLabsTts(text, { gender, rate }) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("elevenlabs_not_configured");
  const voiceId = gender === "male"
    ? (process.env.ELEVENLABS_VOICE_MALE || "pNInz6obpgDQGcFmaJgB")
    : (process.env.ELEVENLABS_VOICE_FEMALE || "21m00Tcm4TlvDq8ikWAM");
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
      language_code: "fil",
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, speed: Math.min(1.2, Math.max(0.7, rate)) },
    }),
  });
  if (!response.ok) throw new Error(`elevenlabs_${response.status}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

async function googleTts(text, { gender, rate }) {
  const key = process.env.GOOGLE_TTS_API_KEY;
  if (!key) throw new Error("google_tts_not_configured");
  const name = gender === "male"
    ? (process.env.GOOGLE_TTS_VOICE_MALE || "fil-PH-Wavenet-C")
    : (process.env.GOOGLE_TTS_VOICE_FEMALE || "fil-PH-Wavenet-A");
  const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: "fil-PH", name },
      audioConfig: { audioEncoding: "MP3", speakingRate: rate },
    }),
  });
  if (!response.ok) throw new Error(`google_tts_${response.status}: ${await response.text()}`);
  const json = await response.json();
  return Buffer.from(json.audioContent, "base64");
}

const TTS_PROVIDERS = { azure: azureTts, elevenlabs: elevenLabsTts, google: googleTts };
// Relative cost weight charged against the user's character allowance.
const TTS_WEIGHT = { azure: 2, google: 2, elevenlabs: 4 };

async function synthesize(text, opts, forcedProvider) {
  const preferred = forcedProvider || process.env.PREMIUM_TTS_PROVIDER || "azure";
  const order = [preferred, "azure"].filter((p, i, a) => TTS_PROVIDERS[p] && a.indexOf(p) === i);
  let lastErr;
  for (const provider of order) {
    try {
      return { audio: await TTS_PROVIDERS[provider](text, opts), provider };
    } catch (err) {
      lastErr = err;
      console.error(`[premium-tts] ${provider} failed:`, err.message);
    }
  }
  throw lastErr || new Error("tts_failed");
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

function mountPremium(app, deps) {
  const {
    requireAuth, stripe, getUserById, resetUserCharsIfNeeded, atomicCheckAndIncrementChars,
    incrementUserTrialChars, insertPendingMeterEvent, getUsage, incrementUsage, logTranslationUsage,
  } = deps;

  const audioCache = new AudioCache(500);
  const llmLimiter = makeUserLimiter(60_000, 30);
  const ttsLimiter = makeUserLimiter(60_000, 60);

  /** Loads the user and rejects anything that isn't Premium, PAYG or admin. */
  async function requirePremium(req, res, next) {
    try {
      let user = await getUserById(req.userId);
      if (!user || !PREMIUM_PLANS.includes(user.plan_status)) {
        return res.status(403).json({ error: "premium_required" });
      }
      if (user.plan_status !== "active") {
        const reset = await resetUserCharsIfNeeded(req.userId);
        if (reset) user = await getUserById(req.userId);
      }
      req.premiumUser = user;
      next();
    } catch (err) {
      console.error("[premium] gate error:", err.message);
      res.status(500).json({ error: "premium_unavailable" });
    }
  }

  /**
   * Pre-check before calling a provider: global monthly cap, and for Premium the user's
   * monthly allowance (atomic, same as /translate). Returns false after sending a response.
   */
  async function reserveChars(req, res, chars) {
    const QUOTA = parseInt(process.env.MONTHLY_CHAR_LIMIT) || 10_000_000;
    const usageRow = await getUsage();
    if (usageRow.current_month_usage_chars + chars > QUOTA * 0.95) {
      res.status(503).json({ error: "usage_cap_reached" });
      return false;
    }
    const user = req.premiumUser;
    if (user.plan_status === "pre") {
      const { allowed } = await atomicCheckAndIncrementChars(req.userId, chars);
      if (!allowed) {
        res.status(402).json({
          error: "monthly_limit_reached",
          message: "You have used your 1,000,000 monthly characters. Your limit resets in 30 days.",
        });
        return false;
      }
    }
    return true;
  }

  /** After a successful call: global usage, extra Premium chars, and PAYG Stripe metering. */
  async function settleChars(req, reservedChars, extraChars, kind) {
    const user = req.premiumUser;
    const total = reservedChars + extraChars;
    try {
      await incrementUsage(total);
      if (user.plan_status === "pre" && extraChars > 0) {
        await incrementUserTrialChars(req.userId, extraChars);
      }
      if (user.plan_status === "payg") {
        await incrementUserTrialChars(req.userId, total);
        const units = Math.ceil(total / 1000);
        if (user.stripe_customer_id && stripe && units > 0) {
          const identifier = `${kind}:${req.userId}:${req.get("x-idempotency-key") || crypto.randomUUID()}`;
          try {
            await stripe.billing.meterEvents.create({
              event_name: "translation_chars",
              payload: { value: String(units), stripe_customer_id: user.stripe_customer_id },
              identifier,
            });
          } catch (e) {
            console.error(`[premium] ${kind} PAYG meter failed (non-fatal):`, e.message);
            await insertPendingMeterEvent(req.userId, user.stripe_customer_id, "translation_chars", units, identifier);
          }
        }
      }
    } catch (err) {
      console.error(`[premium] settle ${kind} failed (non-fatal):`, err.message);
    }
  }

  /** Shared wrapper for every LLM-backed route. build(req) returns { system, user, history?, maxTokens?, inChars, clean(data) }. */
  function llmRoute(kind, build) {
    return async (req, res) => {
      let spec;
      try {
        spec = build(req);
      } catch (err) {
        return res.status(400).json({ error: err.message || "invalid_request" });
      }
      try {
        if (!(await reserveChars(req, res, spec.inChars))) return;
        const { data, outChars } = await llmJson(spec.system, spec.user, {
          maxTokens: spec.maxTokens, temperature: spec.temperature, history: spec.history,
        });
        await settleChars(req, spec.inChars, outChars, kind);
        logTranslationUsage(req.userId, [kind], [false], kind, "en", "tl", "llm");
        res.json(spec.clean ? spec.clean(data) : data);
      } catch (err) {
        console.error(`[premium] ${kind} error:`, err.response?.data || err.message);
        res.status(500).json({ error: `${kind}_unavailable` });
      }
    };
  }

  const guard = [requireAuth, jsonBody, requirePremium];

  // --- Access check the extension uses to decide whether to show Premium UI -------------
  app.get("/premium/status", requireAuth, async (req, res) => {
    try {
      const user = await getUserById(req.userId);
      const plan = user?.plan_status || null;
      res.json({
        plan,
        premium: PREMIUM_PLANS.includes(plan),
        voiceProvider: process.env.PREMIUM_TTS_PROVIDER || "azure",
      });
    } catch (err) {
      res.status(500).json({ error: "premium_unavailable" });
    }
  });

  // --- 1. Better Filipino Voice --------------------------------------------------------
  app.post("/premium/tts", ...guard, ttsLimiter, async (req, res) => {
    const text = clampStr(req.body.text, 600);
    if (!text) return res.status(400).json({ error: "Invalid text" });
    const gender = req.body.gender === "male" ? "male" : "female";
    const style = ["tagalog", "taglish", "auto"].includes(req.body.style) ? req.body.style : "auto";
    const rate = Math.min(1.2, Math.max(0.6, Number(req.body.rate) || 1));
    // Only admins can force a provider, for side-by-side voice evaluation.
    const forced = req.premiumUser.plan_status === "active" && TTS_PROVIDERS[req.body.provider] ? req.body.provider : null;

    const cacheKey = crypto.createHash("sha1").update([forced || "", gender, style, rate, text].join("|")).digest("hex");
    const cached = audioCache.get(cacheKey);
    if (cached) {
      res.set("Content-Type", "audio/mpeg");
      res.set("X-Hari-Voice", cached.provider);
      return res.send(cached.audio);
    }

    try {
      const preferred = forced || process.env.PREMIUM_TTS_PROVIDER || "azure";
      const weighted = text.length * (TTS_WEIGHT[preferred] || 2);
      if (!(await reserveChars(req, res, weighted))) return;
      const { audio, provider } = await synthesize(text, { gender, style, rate }, forced);
      audioCache.set(cacheKey, { audio, provider });
      await settleChars(req, weighted, 0, "tts");
      logTranslationUsage(req.userId, [text], [false], "tts", "fil", "fil", "tts");
      res.set("Content-Type", "audio/mpeg");
      res.set("X-Hari-Voice", provider);
      res.send(audio);
    } catch (err) {
      console.error("[premium-tts] error:", err.message);
      res.status(502).json({ error: "tts_unavailable" });
    }
  });

  // --- 2. Zeron, the AI tutor -----------------------------------------------------------
  app.post("/premium/tutor", ...guard, llmLimiter, llmRoute("tutor", (req) => {
    const level = normLevel(req.body.level);
    const mode = req.body.mode === "roleplay" ? "roleplay" : "chat";
    const scenario = clampStr(req.body.scenario, 300);
    const savedWords = clampList(req.body.savedWords, 40, (w) => {
      const tl = clampStr(w?.tagalog, 60);
      return tl ? `${tl} (${clampStr(w?.english, 60)})` : null;
    });
    const mistakes = clampList(req.body.mistakes, 15, (m) => clampStr(m, 200));
    const history = clampList(req.body.messages, 20, (m) => {
      const content = clampStr(m?.content, 1200);
      if (!content) return null;
      return { role: m.role === "assistant" ? "assistant" : "user", content };
    });
    if (!history.length || history[history.length - 1].role !== "user") throw new Error("messages must end with a user turn");

    const system = `${TAGALOG_EXPERT}

You are Zeron, Hari's warm, encouraging Tagalog tutor. The learner is ${level}.
${mode === "roleplay"
    ? `You are role-playing this situation with them: "${scenario || "ordering food at a carinderia"}". Stay in character as the other person in the scene, keep the scene moving, and keep your lines short and realistic.`
    : "Have a natural conversation that helps them practice. Ask one follow-up question each turn to keep them talking."}
Language mix: beginner = mostly simple Tagalog with English support; intermediate = mostly Tagalog with light Taglish; advanced = natural Tagalog/Taglish like a Manila local.
${savedWords.length ? `Naturally reuse some of the learner's saved words when it fits: ${savedWords.join(", ")}.` : ""}
${mistakes.length ? `They have recently struggled with: ${mistakes.join("; ")}. Gently create chances to practice these.` : ""}
If the learner's last message has Tagalog mistakes or sounds unnatural, include corrections. Never correct English the learner uses on purpose to ask a question.

Return JSON:
{
  "reply": string (your next line, in Tagalog/Taglish appropriate to their level),
  "replyEnglish": string (English translation of reply),
  "corrections": [{ "original": string, "corrected": string, "explanation": string (short, English) }],
  "tip": string (optional one-sentence grammar or culture tip in English, or ""),
  "suggestedReplies": [string] (2-3 short Tagalog things the learner could say next)
}`;
    const inChars = system.length / 4 + history.reduce((n, m) => n + m.content.length, 0);
    return {
      system, user: null, history, maxTokens: 700, temperature: 0.8, inChars: Math.ceil(inChars),
      clean: (d) => ({
        reply: String(d.reply || ""),
        replyEnglish: String(d.replyEnglish || ""),
        corrections: Array.isArray(d.corrections) ? d.corrections.slice(0, 5) : [],
        tip: String(d.tip || ""),
        suggestedReplies: Array.isArray(d.suggestedReplies) ? d.suggestedReplies.slice(0, 3).map(String) : [],
      }),
    };
  }));

  // --- 4. Practice: generate Sentence Builder / Listening exercises -------------------------
  app.post("/premium/practice/generate", ...guard, llmLimiter, llmRoute("practice", (req) => {
    const level = normLevel(req.body.level);
    const type = ["builder", "translate", "listening"].includes(req.body.type) ? req.body.type : "builder";
    const count = Math.min(5, Math.max(1, parseInt(req.body.count) || 3));
    const words = clampList(req.body.words, 20, (w) => {
      const tl = clampStr(w?.tagalog, 60);
      return tl ? `${tl} = ${clampStr(w?.english, 60)}` : null;
    });
    const shapes = {
      builder: `{ "exercises": [{ "english": string (sentence to express), "tagalog": string (natural answer), "tiles": [string] (the answer split into word tiles, in correct order), "distractors": [string] (1-3 extra plausible wrong tiles), "hint": string (English) }] }`,
      translate: `{ "exercises": [{ "english": string (everyday phrase), "tagalog": string (most natural answer), "acceptable": [string] (other correct answers), "hint": string (English) }] }`,
      listening: `{ "exercises": [{ "kind": "phrase" | "dialogue", "lines": [{ "speaker": "A" | "B", "tagalog": string, "english": string }] (1 line for phrase, 2-4 for dialogue), "question": string (English comprehension question), "choices": [string] (4 English choices), "answerIndex": number, "explanation": string (English) }] }`,
    };
    const system = `${TAGALOG_EXPERT}\nCreate ${count} ${type} exercises for a ${level} learner. Use everyday, modern situations (family, food, commuting, work, texting). Vary sentence structure. Return JSON exactly shaped like:\n${shapes[type]}`;
    const user = words.length
      ? `Build the exercises around these words the learner saved (use at least one per exercise where natural): ${words.join("; ")}`
      : "Use common high-frequency vocabulary.";
    return {
      system, user, maxTokens: 1400, temperature: 0.9, inChars: Math.ceil(system.length / 4 + user.length),
      clean: (d) => ({ type, exercises: Array.isArray(d.exercises) ? d.exercises.slice(0, count) : [] }),
    };
  }));

  // --- 4. Practice: Explain My Mistake ---------------------------------------------------
  app.post("/premium/practice/check", ...guard, llmLimiter, llmRoute("explain", (req) => {
    const level = normLevel(req.body.level);
    const prompt = clampStr(req.body.prompt, 400);
    const expected = clampStr(req.body.expected, 400);
    const answer = clampStr(req.body.answer, 400);
    const kind = clampStr(req.body.kind, 40) || "translation";
    if (!prompt || !answer) throw new Error("prompt and answer are required");
    const system = `${TAGALOG_EXPERT}
A ${level} learner answered a ${kind} exercise. Judge meaning, grammar (focus/aspect, markers ang/ng/sa, linkers na/-ng, pronoun order, po/opo) and naturalness. Accept any answer a native speaker would accept, even if different from the reference.
Return JSON:
{
  "verdict": "correct" | "almost" | "incorrect",
  "summary": string (one encouraging sentence, English),
  "mistakes": [{ "part": string (the learner's words), "type": "grammar" | "word choice" | "spelling" | "meaning" | "naturalness", "explanation": string (English, plain and specific) }],
  "corrected": string (the learner's answer, minimally fixed),
  "moreNatural": [{ "tagalog": string, "note": string (when/why a local would say it) }],
  "rule": string (the one key grammar point to remember, English, or "")
}`;
    const user = `Exercise: ${prompt}\nReference answer: ${expected || "(none)"}\nLearner answer: ${answer}`;
    return {
      system, user, maxTokens: 800, temperature: 0.3, inChars: Math.ceil(system.length / 4 + user.length),
      clean: (d) => ({
        verdict: ["correct", "almost", "incorrect"].includes(d.verdict) ? d.verdict : "incorrect",
        summary: String(d.summary || ""),
        mistakes: Array.isArray(d.mistakes) ? d.mistakes.slice(0, 6) : [],
        corrected: String(d.corrected || ""),
        moreNatural: Array.isArray(d.moreNatural) ? d.moreNatural.slice(0, 3) : [],
        rule: String(d.rule || ""),
      }),
    };
  }));

  // --- 6. Say It Like a Filipino ---------------------------------------------------------
  app.post("/premium/say-it", ...guard, llmLimiter, llmRoute("sayit", (req) => {
    const text = clampStr(req.body.text, 500);
    const context = clampStr(req.body.context, 200);
    if (!text) throw new Error("text is required");
    const system = `${TAGALOG_EXPERT}
The learner wants to express something in natural Filipino. Give how real Filipinos would actually say it, not a literal translation.
Return JSON:
{
  "casual": { "tagalog": string, "note": string (who/when, English) },
  "taglish": { "tagalog": string, "note": string },
  "respectful": { "tagalog": string (with po/opo where natural), "note": string },
  "formal": { "tagalog": string, "note": string },
  "literal": { "tagalog": string (word-for-word translation), "whyUnnatural": string (English; or "" if the literal version is already natural) },
  "breakdown": [{ "tagalog": string, "english": string }] (key words/particles in the casual version),
  "culture": string (one short cultural note in English, or "")
}`;
    const user = `Say this: "${text}"${context ? `\nContext: ${context}` : ""}`;
    return { system, user, maxTokens: 900, temperature: 0.5, inChars: Math.ceil(system.length / 4 + user.length) };
  }));

  // --- 5. Video subtitles: translate caption lines in a batch -------------------------------
  app.post("/premium/subtitles", ...guard, llmLimiter, llmRoute("subtitles", (req) => {
    const lines = clampList(req.body.lines, 12, (l) => {
      const text = clampStr(l?.text, 300);
      return text ? { id: clampStr(String(l.id ?? ""), 40), text } : null;
    });
    if (!lines.length) throw new Error("lines are required");
    const level = normLevel(req.body.level);
    const system = `${TAGALOG_EXPERT}
You are subtitling a video for a ${level} Tagalog learner. For each caption line: if it is English, give a natural spoken Tagalog/Taglish version (how a Filipino would say it on screen); if it is Tagalog, keep it and clean up obvious caption errors. Always also give English.
Return JSON: { "lines": [{ "id": string, "tl": string, "en": string, "note": string (short English note on slang/idiom/grammar worth knowing, or "") }] }`;
    const user = JSON.stringify(lines);
    return {
      system, user, maxTokens: 1600, temperature: 0.3, inChars: Math.ceil(system.length / 4 + user.length),
      clean: (d) => ({ lines: Array.isArray(d.lines) ? d.lines : [] }),
    };
  }));
}

module.exports = { mountPremium, synthesize, TTS_PROVIDERS, PREMIUM_PLANS };
