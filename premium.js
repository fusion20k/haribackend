// Premium + PAYG features: better voice, Thea (AI tutor), practice exercises with
// "Explain My Mistake", "Say It Like a Native", video subtitle translation, the Shadowing Coach
// and the Reading Level Meter's article feed.
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

function normWords(t) {
  return String(t || "").toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
}

/** Drops corrections that don't quote the learner's latest message (the model sometimes repeats old ones). */
function correctionsFor(latest, list) {
  if (!Array.isArray(list)) return [];
  const said = new Set(normWords(latest));
  return list
    .filter((c) => c && c.original && c.corrected)
    .filter((c) => {
      const words = normWords(c.original);
      if (!words.length) return false;
      const hits = words.filter((w) => said.has(w)).length;
      return hits / words.length >= 0.6;
    })
    .filter((c) => normWords(c.original).join(" ") !== normWords(c.corrected).join(" "))
    .slice(0, 5)
    .map((c) => ({ original: String(c.original), corrected: String(c.corrected), explanation: String(c.explanation || "") }));
}

const TAGALOG_EXPERT =
  "You are an expert Filipino (Tagalog) teacher who grew up in Metro Manila. You know how people really talk today, " +
  "including natural Taglish code-switching, po/opo politeness, and regional nuance. Be accurate: never invent words. " +
  "Explanations are in clear, friendly English. " +
  // many learners are Filipino Americans, so never frame phrasing as what "a Filipino" or "Filipinos" say
  "When describing natural phrasing, say \"a native speaker\" or \"natives\", never \"a Filipino\" or \"Filipinos\" " +
  "(for example \"here is how a native speaker would say it\"). " +
  "Respond with valid JSON only, matching the requested shape exactly.";

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

async function azureTts(text, { gender, style, rate, azureVoice }) {
  if (!process.env.AZURE_SPEECH_KEY) throw new Error("azure_tts_not_configured");
  const region = process.env.AZURE_SPEECH_REGION || "eastus";
  const ratePct = `${Math.round((rate - 1) * 100)}%`;
  const safe = escapeXml(text);
  const taglish = style === "taglish" || (style === "auto" && looksTaglish(text));
  let ssml;
  if (azureVoice) {
    // a voice the user picked in the sidebar
    ssml = azureVoice.multilingual
      ? `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="fil-PH"><voice name="${azureVoice.name}"><lang xml:lang="fil-PH"><prosody rate="${ratePct}">${safe}</prosody></lang></voice></speak>`
      : `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="fil-PH"><voice name="${azureVoice.name}"><prosody rate="${ratePct}">${safe}</prosody></voice></speak>`;
  } else if (taglish) {
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

// ElevenLabs: one voice for every Premium/PAYG user (Aisyah by default) on Eleven v4 Turbo.
// The voice is found by name in the ElevenLabs account unless ELEVENLABS_VOICE_ID is set.
// If the API rejects the main model, the fallback model is tried before Azure takes over.
const ELEVEN_API = "https://api.elevenlabs.io";
const eleven = { voiceId: null, lookupFailedAt: 0, modelLogged: false };

async function resolveElevenVoice(key) {
  if (process.env.ELEVENLABS_VOICE_ID) return process.env.ELEVENLABS_VOICE_ID.trim();
  if (eleven.voiceId) return eleven.voiceId;
  if (Date.now() - eleven.lookupFailedAt < 10 * 60 * 1000) throw new Error("elevenlabs_voice_not_found");
  const wanted = (process.env.ELEVENLABS_VOICE_NAME || "Aisyah").trim().toLowerCase();
  const headers = { "xi-api-key": key, Accept: "application/json" };
  const pick = (voices) => (voices || []).find((v) => String(v.name || "").trim().toLowerCase().startsWith(wanted));
  let match = null;
  let denied = null;
  try {
    const r = await fetch(`${ELEVEN_API}/v2/voices?search=${encodeURIComponent(wanted)}&page_size=20`, { headers });
    if (r.ok) match = pick((await r.json()).voices);
    else if (r.status === 401 || r.status === 403) denied = `${r.status} ${(await r.text()).slice(0, 200)}`;
  } catch (_) { /* try the v1 list below */ }
  if (!match) {
    const r = await fetch(`${ELEVEN_API}/v1/voices`, { headers });
    if (r.ok) match = pick((await r.json()).voices);
    else if (r.status === 401 || r.status === 403) denied = `${r.status} ${(await r.text()).slice(0, 200)}`;
  }
  if (!match) {
    eleven.lookupFailedAt = Date.now();
    if (denied) {
      console.error(`[premium-tts] ElevenLabs refused to list voices (${denied}). Either give the API key the "Voices: Read" permission in ElevenLabs, or set ELEVENLABS_VOICE_ID in Render to Aisyah's voice ID.`);
    } else {
      console.error(`[premium-tts] ElevenLabs voice "${wanted}" not found in this account's My Voices. Add it there, or set ELEVENLABS_VOICE_ID.`);
    }
    throw new Error("elevenlabs_voice_not_found");
  }
  eleven.voiceId = match.voice_id;
  console.log(`[premium-tts] ElevenLabs voice: ${match.name} (${match.voice_id})`);
  return eleven.voiceId;
}

function elevenHint(status, detail) {
  const d = String(detail || '').toLowerCase();
  if (d.includes('quota') || d.includes('credits') || status === 402) return ' -> out of ElevenLabs characters/balance: top up or wait for the monthly reset.';
  if (d.includes('permission') || d.includes('missing_permissions')) return ' -> the API key is missing a permission. In ElevenLabs, edit the key and allow Text to Speech, Speech to Text and Voices (read).';
  if (d.includes('invalid_api_key') || d.includes('invalid api key') || status === 401) return ' -> ELEVENLABS_API_KEY is wrong or was deleted. Paste a fresh key into Render.';
  if (d.includes('voice') && (d.includes('not found') || status === 404)) return ' -> voice not available to this key. Add Aisyah to My Voices or fix ELEVENLABS_VOICE_ID.';
  if (d.includes('paid') || d.includes('subscription') || d.includes('library')) return ' -> this voice needs a paid ElevenLabs plan (Starter or higher).';
  if (status === 400 || status === 422) return ' -> model or setting rejected, trying the fallback model.';
  return '';
}

/** Runs once at startup so the Render log says plainly which voice Premium users will hear. */
async function elevenStartupCheck() {
  const provider = defaultTtsProvider();
  if (provider !== 'elevenlabs') {
    console.log(`[premium-tts] Premium voice: ${provider}${process.env.ELEVENLABS_API_KEY ? '' : ' (ELEVENLABS_API_KEY is not set in Render, so Aisyah is off)'}`);
    return;
  }
  try {
    const audio = await elevenLabsTts('Kumusta.', { style: 'auto', rate: 1 });
    console.log(`[premium-tts] Premium voice check OK: ElevenLabs is working (${audio.length} bytes test clip).`);
  } catch (err) {
    console.error(`[premium-tts] Premium voice check FAILED, users will hear Azure until this is fixed: ${err.message}`);
  }
}

async function elevenLabsTts(text, { style, rate }) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("elevenlabs_not_configured");
  const voiceId = await resolveElevenVoice(key);
  const models = [process.env.ELEVENLABS_MODEL || "eleven_v4_turbo", process.env.ELEVENLABS_FALLBACK_MODEL || "eleven_flash_v2_5"]
    .filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr;
  for (const model of models) {
    // first try with every option; if the model rejects one, retry with the plain request
    const attempts = [true, false];
    for (const full of attempts) {
      const body = {
        text,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      };
      if (full) {
        if (style === "tagalog") body.language_code = "fil";
        if (rate !== 1) body.voice_settings.speed = Math.min(1.2, Math.max(0.7, rate));
      }
      const response = await fetch(`${ELEVEN_API}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        if (!eleven.modelLogged || model !== models[0]) {
          console.log(`[premium-tts] ElevenLabs model in use: ${model}`);
          eleven.modelLogged = true;
        }
        return Buffer.from(await response.arrayBuffer());
      }
      const detail = await response.text();
      lastErr = new Error(`elevenlabs_${response.status} (${model}): ${detail.slice(0, 300)}${elevenHint(response.status, detail)}`);
      // bad key, no credits, or rate limited: other models won't help, let Azure take this one
      if ([401, 402, 403, 429].includes(response.status) || response.status >= 500) throw lastErr;
      if (response.status === 404 && /voice/i.test(detail)) { eleven.voiceId = null; throw lastErr; }
      const optionProblem = full && (body.language_code || body.voice_settings.speed) && [400, 422].includes(response.status);
      if (!optionProblem) break; // model itself was rejected: move on to the fallback model
    }
    console.error(`[premium-tts] ${lastErr.message}`);
  }
  throw lastErr || new Error("elevenlabs_failed");
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

/** PREMIUM_TTS_PROVIDER wins; otherwise ElevenLabs as soon as its key is set, else Azure. */
function defaultTtsProvider() {
  if (process.env.PREMIUM_TTS_PROVIDER) return process.env.PREMIUM_TTS_PROVIDER;
  return process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "azure";
}
// Relative cost weight charged against the user's character allowance.
const TTS_WEIGHT = { azure: 2, google: 2, elevenlabs: 4 };

// Voices Premium/PAYG users can pick in the sidebar. "aisyah" is the default.
const PREMIUM_VOICES = {
  aisyah: { provider: "elevenlabs", gender: "female" },
  blessica: { provider: "azure", gender: "female", azureVoice: { name: "fil-PH-BlessicaNeural", multilingual: false } },
  angelo: { provider: "azure", gender: "male", azureVoice: { name: "fil-PH-AngeloNeural", multilingual: false } },
  ava: { provider: "azure", gender: "female", azureVoice: { name: "en-US-Ava:DragonHDLatestNeural", multilingual: true } },
  andrew: { provider: "azure", gender: "male", azureVoice: { name: "en-US-Andrew:DragonHDLatestNeural", multilingual: true } },
};

async function synthesize(text, opts, forcedProvider) {
  const preferred = forcedProvider || defaultTtsProvider();
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

// ---------------------------------------------------------------------------
// Shadowing Coach: compare what the learner said with the line they were copying
// ---------------------------------------------------------------------------

/** Lowercase, accents and punctuation removed, so "Kumusta?" and "kumustá" compare equal. */
function plainWord(w) {
  return String(w || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function wordSimilarity(a, b) {
  const x = plainWord(a);
  const y = plainWord(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return Math.max(0, 1 - levenshtein(x, y) / Math.max(x.length, y.length));
}

/** Target words that carry sound (punctuation-only tokens dropped), keeping the learner's spelling for display. */
function targetWords(text) {
  return String(text || "").split(/\s+/).map((w) => w.trim()).filter((w) => plainWord(w));
}

/**
 * Order-preserving alignment of target words to heard words that maximises total similarity.
 * Returns, for each target word, the index of the heard word it matched (or -1).
 */
function alignWords(target, heard) {
  const n = target.length;
  const m = heard.length;
  const sim = target.map((t) => heard.map((h) => wordSimilarity(t, h)));
  const best = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const pair = sim[i][j] >= 0.4 ? sim[i][j] + best[i + 1][j + 1] : -1;
      best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], pair);
    }
  }
  const out = new Array(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sim[i][j] >= 0.4 && best[i][j] === sim[i][j] + best[i + 1][j + 1]) { out[i] = j; i++; j++; }
    else if (best[i][j] === best[i + 1][j]) i++;
    else j++;
  }
  return out;
}

function wordStatus(score) {
  return score >= 85 ? "good" : score >= 55 ? "close" : "missed";
}

/** Similarity 0..1 to a strict 0..100 score: half-right is 0, one letter off in a long word is about 80. */
function strictScore(sim) {
  return Math.max(0, Math.min(100, Math.round(((sim - 0.5) / 0.5) * 100)));
}

const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(v)));

/**
 * Score from a transcript (ElevenLabs Scribe with word timings, or plain text).
 * heardWords: [{ text, start, end }] or null; heardText: the full transcript.
 */
function scoreFromTranscript(targetText, heardWords, heardText) {
  const target = targetWords(targetText);
  const heard = heardWords && heardWords.length
    ? heardWords.filter((w) => plainWord(w.text))
    : targetWords(heardText).map((t) => ({ text: t }));
  const match = alignWords(target, heard.map((h) => h.text));
  const words = target.map((word, i) => {
    const h = match[i] >= 0 ? heard[match[i]] : null;
    const score = h ? strictScore(wordSimilarity(word, h.text)) : 0;
    return { word, heard: h ? h.text : "", score, status: wordStatus(score) };
  });
  const accuracy = words.length ? clamp100(words.reduce((a, w) => a + w.score, 0) / words.length) : 0;
  const completeness = words.length ? clamp100((100 * words.filter((w) => w.score >= 55).length) / words.length) : 0;

  // pace and hesitation from word timings, when the recogniser gives them
  let fluency = null;
  let pace = null;
  const timed = heard.filter((w) => typeof w.start === "number" && typeof w.end === "number");
  if (timed.length >= 2) {
    const dur = Math.max(0.3, timed[timed.length - 1].end - timed[0].start);
    const syllables = timed.reduce((a, w) => a + Math.max(1, (plainWord(w.text).match(/[aeiou]+/g) || []).length), 0);
    pace = Math.round((syllables / dur) * 10) / 10;
    let gaps = 0;
    for (let k = 1; k < timed.length; k++) if (timed[k].start - timed[k - 1].end > 0.6) gaps++;
    fluency = clamp100(100 - gaps * 12 - (pace < 2.8 ? (2.8 - pace) * 18 : 0) - (pace > 8 ? 10 : 0));
    fluency = Math.max(30, fluency);
  }
  if (fluency != null) fluency = Math.min(fluency, accuracy + 25);
  // smooth delivery only counts as much as the words were right
  const overall = clamp100(accuracy * 0.7 + completeness * 0.15 + (fluency == null ? accuracy : fluency) * 0.15 * (accuracy / 100));
  return { overall, accuracy, completeness, fluency, prosody: null, pace, words, heard: String(heardText || "").trim() };
}

/**
 * Azure can be generous when it force-aligns speech to the reference line, so its scores are capped
 * by what was actually heard: each word and the totals take the lower of the two.
 */
function capByTranscript(az, heard) {
  if (!heard) return az;
  const words = az.words.map((w, i) => {
    const h = heard.words[i];
    const hs = h ? h.score : 0;
    // Azure sometimes drops a Tagalog word it didn't recognize that was said clearly
    const score = w.score === 0 && hs >= 85 ? hs - 15 : Math.min(w.score, hs);
    return { word: w.word, heard: h ? h.heard : "", score, status: wordStatus(score) };
  });
  const accuracy = Math.min(az.accuracy, heard.accuracy);
  const capped = (v) => (v == null ? null : Math.min(v, accuracy + 25)); // smooth but wrong is not fluent
  return {
    ...az,
    words,
    overall: Math.min(az.overall, heard.overall),
    accuracy,
    completeness: Math.min(az.completeness, heard.completeness),
    fluency: capped(az.fluency == null ? heard.fluency : Math.min(az.fluency, heard.fluency == null ? 100 : heard.fluency)),
    prosody: capped(az.prosody),
    pace: heard.pace,
    heard: heard.heard || az.heard,
  };
}

/** Azure pronunciation assessment result (format=detailed) to the same shape. Null if it holds no scores. */
function scoreFromAzure(targetText, data) {
  const nb = data && Array.isArray(data.NBest) ? data.NBest[0] : null;
  if (!nb) return null;
  const pa = nb.PronunciationAssessment || nb;
  if (typeof pa.AccuracyScore !== "number" || typeof pa.PronScore !== "number") return null;
  const target = targetWords(targetText);
  const az = (nb.Words || [])
    .map((w) => ({ text: w.Word, a: w.PronunciationAssessment || w }))
    .filter((w) => w.a.ErrorType !== "Insertion");
  const match = alignWords(target, az.map((w) => w.text));
  const words = target.map((word, i) => {
    const w = match[i] >= 0 ? az[match[i]] : null;
    const omitted = !w || w.a.ErrorType === "Omission";
    const score = omitted ? 0 : clamp100(w.a.AccuracyScore);
    const status = omitted ? "missed" : score >= 80 ? "good" : score >= 60 ? "close" : "missed";
    return { word, heard: omitted ? "" : w.text, score, status };
  });
  return {
    overall: clamp100(pa.PronScore),
    accuracy: clamp100(pa.AccuracyScore),
    completeness: clamp100(pa.CompletenessScore ?? 100),
    fluency: typeof pa.FluencyScore === "number" ? clamp100(pa.FluencyScore) : null,
    prosody: typeof pa.ProsodyScore === "number" ? clamp100(pa.ProsodyScore) : null,
    pace: null,
    words,
    heard: String(nb.Display || data.DisplayText || "").trim(),
    lexical: String(nb.Lexical || nb.Display || "").trim(),
  };
}

// ---------------------------------------------------------------------------
// Reading Level Meter: real Tagalog articles from news sites with full-text feeds
// ---------------------------------------------------------------------------
// Topic feeds come first so a story shared with a general news feed keeps its topic.
const TAGALOG_FEEDS = [
  { source: "Pinoy Collection", topic: "stories", url: "https://pinoycollection.com/category/maikling-kwento/feed/" },
  { source: "Pinoy Collection", topic: "stories", url: "https://pinoycollection.com/category/maikling-kwento/feed/?paged=2" },
  { source: "Pinoy Collection", topic: "stories", url: "https://pinoycollection.com/category/maikling-kwento/feed/?paged=3" },
  { source: "Pinoy Collection", topic: "stories", url: "https://pinoycollection.com/feed/" },
  { source: "Bombo Radyo", topic: "showbiz", url: "https://www.bomboradyo.com/category/entertainment/feed/" },
  { source: "Bombo Radyo", topic: "sports", url: "https://www.bomboradyo.com/category/sports/feed/" },
  { source: "Bombo Radyo", topic: "news", url: "https://www.bomboradyo.com/feed/" },
  { source: "RMN", topic: "news", url: "https://www.rmn.ph/feed/" },
];
const ARTICLES_PER_TOPIC = { stories: 20, showbiz: 12, sports: 12, news: 12 };
// school study guides (chapter summaries, "elements of a short story") aren't fun reading
const STUDY_GUIDE = /\b(buod|kabanata|mga elemento|kahulugan|halimbawa|uri at|aralin)\b|\(\d+ (kwento|tula)\)/i;

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ").replace(/&hellip;/g, "...").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function feedField(item, tag) {
  const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
}

function htmlToText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<(script|style|figure|figcaption)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|h\d|li|br)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .normalize("NFKC") // some headlines use styled Unicode letters (bold/italic); make them plain
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "") // invisible direction marks
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

// Tagalog vs the other big Philippine languages, by their most common little words.
const TL_MARKERS = new Set(["ang", "ng", "mga", "na", "at", "ay", "hindi", "ito", "siya", "nang", "naman", "rin", "din", "kung", "para", "po", "lang", "ni", "kay", "niya"]);
const OTHER_MARKERS = new Set(["ug", "nga", "og", "dili", "kini", "kana", "niini", "usab", "mao", "karon", "atong", "didto", "gikan", "ti", "dagiti", "ken", "iti", "isu", "idi", "ngem", "ket", "daytoy"]);
function isTagalogText(text) {
  const words = String(text || "").toLowerCase().match(/\p{L}+/gu) || [];
  if (words.length < 15) return false;
  let tl = 0;
  let other = 0;
  for (const w of words) {
    if (TL_MARKERS.has(w)) tl++;
    if (OTHER_MARKERS.has(w)) other++;
  }
  return tl / words.length >= 0.08 && tl > other * 3;
}

function parseFeed(xml, source) {
  const items = String(xml || "").match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return items.map((item) => {
    const title = htmlToText(feedField(item, "title"));
    const link = decodeEntities(feedField(item, "link")).trim();
    const body = htmlToText(feedField(item, "content:encoded") || feedField(item, "description"));
    const date = Date.parse(feedField(item, "pubDate")) || 0;
    return { title, link, source, date, text: body.slice(0, 3000) };
  }).filter((a) => a.title && /^https:\/\//.test(a.link) && a.text.length > 200 && isTagalogText(a.text));
}

function mountPremium(app, deps) {
  const {
    requireAuth, stripe, getUserById, resetUserCharsIfNeeded, atomicCheckAndIncrementChars,
    incrementUserTrialChars, insertPendingMeterEvent, getUsage, incrementUsage, logTranslationUsage,
  } = deps;

  const audioCache = new AudioCache(500);
  const { pool } = deps;
  setTimeout(() => { elevenStartupCheck().catch(() => {}); }, 3000);

  // Shared audio cache: once any user has heard a word or phrase in a voice, everyone reuses it,
  // across restarts. Cache hits cost nothing (no provider call, nothing charged to the user).
  // Only words and short phrases go to the database: they're what repeats across users. Long Thea
  // lines are unique per conversation and stay in the memory caches. A hard size cap keeps the
  // table well inside Supabase's free 500 MB database.
  const DB_CACHE_MAX_TEXT = parseInt(process.env.TTS_CACHE_MAX_TEXT) || 100;
  const DB_CACHE_MAX_BYTES = (parseInt(process.env.TTS_CACHE_MAX_MB) || 150) * 1024 * 1024;
  let dbCacheReady = false;
  let dbInserts = 0;
  if (pool) {
    pool.query(`CREATE TABLE IF NOT EXISTS premium_tts_cache (
        cache_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        audio BYTEA NOT NULL,
        bytes INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
      .then(() => pool.query("CREATE INDEX IF NOT EXISTS premium_tts_cache_last_used ON premium_tts_cache (last_used)"))
      .then(() => { dbCacheReady = true; })
      .catch((err) => console.error("[premium-tts] cache table:", err.message));
  }

  async function dbCacheGet(key) {
    if (!dbCacheReady) return null;
    try {
      const r = await pool.query("SELECT provider, audio, last_used FROM premium_tts_cache WHERE cache_key = $1", [key]);
      if (!r.rowCount) return null;
      const row = r.rows[0];
      if (Date.now() - new Date(row.last_used).getTime() > 86400000) {
        pool.query("UPDATE premium_tts_cache SET last_used = NOW() WHERE cache_key = $1", [key]).catch(() => {});
      }
      return { provider: row.provider, audio: row.audio };
    } catch (err) {
      console.error("[premium-tts] cache read:", err.message);
      return null;
    }
  }

  // Drop the least recently used clips once the table passes the size cap (trims to 90% of it).
  async function dbCacheTrim() {
    const total = await pool.query("SELECT COALESCE(SUM(bytes), 0)::bigint AS total FROM premium_tts_cache");
    const used = Number(total.rows[0].total);
    if (used <= DB_CACHE_MAX_BYTES) return;
    const r = await pool.query(
      `DELETE FROM premium_tts_cache WHERE cache_key IN (
         SELECT cache_key FROM (
           SELECT cache_key, SUM(bytes) OVER (ORDER BY last_used DESC) AS running FROM premium_tts_cache
         ) t WHERE running > $1)`,
      [Math.floor(DB_CACHE_MAX_BYTES * 0.9)]
    );
    console.log(`[premium-tts] cache trimmed: ${(used / 1048576).toFixed(1)} MB over the cap, removed ${r.rowCount} old clips`);
  }

  async function dbCachePut(key, provider, audio) {
    if (!dbCacheReady) return;
    try {
      await pool.query(
        "INSERT INTO premium_tts_cache (cache_key, provider, audio, bytes) VALUES ($1, $2, $3, $4) ON CONFLICT (cache_key) DO NOTHING",
        [key, provider, audio, audio.length]
      );
      if (++dbInserts % 50 === 1) await dbCacheTrim();
    } catch (err) {
      console.error("[premium-tts] cache write:", err.message);
    }
  }
  const llmLimiter = makeUserLimiter(60_000, 30);
  const ttsLimiter = makeUserLimiter(60_000, 60);
  const sttLimiter = makeUserLimiter(60_000, 40);

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
        voiceProvider: defaultTtsProvider(),
        voices: Object.keys(PREMIUM_VOICES),
        elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      });
    } catch (err) {
      res.status(500).json({ error: "premium_unavailable" });
    }
  });

  // --- 1. Better Filipino Voice --------------------------------------------------------
  app.post("/premium/tts", ...guard, ttsLimiter, async (req, res) => {
    const text = clampStr(req.body.text, 600);
    if (!text) return res.status(400).json({ error: "Invalid text" });
    const style = ["tagalog", "taglish", "auto"].includes(req.body.style) ? req.body.style : "auto";
    const rate = Math.min(1.2, Math.max(0.6, Number(req.body.rate) || 1));
    const choice = PREMIUM_VOICES[req.body.voice] ? req.body.voice : null;
    const picked = choice ? PREMIUM_VOICES[choice] : null;
    const gender = picked ? picked.gender : (req.body.gender === "male" ? "male" : "female");
    // Admins can still force a provider for side-by-side voice evaluation.
    const adminForced = req.premiumUser.plan_status === "active" && TTS_PROVIDERS[req.body.provider] ? req.body.provider : null;
    const forced = adminForced || (picked ? picked.provider : null);
    const intended = forced || defaultTtsProvider();

    // The key names the voice actually wanted, so audio from a temporary fallback is never
    // stored under it. ElevenLabs uses one voice for everyone, so gender doesn't split its cache.
    const voiceKey = choice || (intended === "elevenlabs" ? "aisyah" : `${intended}:${gender}`);
    const cacheKey = crypto.createHash("sha1").update(["v2", voiceKey, style, rate, text].join("|")).digest("hex");
    const send = (audio, provider) => {
      res.set("Content-Type", "audio/mpeg");
      res.set("X-Hari-Voice", provider);
      res.send(audio);
    };
    const memHit = audioCache.get(cacheKey);
    if (memHit) return send(memHit.audio, memHit.provider);
    const dbHit = text.length <= DB_CACHE_MAX_TEXT ? await dbCacheGet(cacheKey) : null;
    if (dbHit) {
      audioCache.set(cacheKey, dbHit);
      return send(dbHit.audio, dbHit.provider);
    }

    try {
      const weighted = text.length * (TTS_WEIGHT[intended] || 2);
      if (!(await reserveChars(req, res, weighted))) return;
      const { audio, provider } = await synthesize(text, { gender, style, rate, azureVoice: picked && picked.azureVoice }, forced);
      if (provider === intended) {
        audioCache.set(cacheKey, { audio, provider });
        if (text.length <= DB_CACHE_MAX_TEXT) dbCachePut(cacheKey, provider, audio);
      }
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

  // --- Speech to text for Thea (the extension records 16 kHz mono WAV from the chosen mic) ---
  const wavBody = express.raw({ type: ["audio/wav", "audio/wave", "audio/x-wav"], limit: "2.5mb" });
  app.post("/premium/stt", requireAuth, wavBody, requirePremium, sttLimiter, async (req, res) => {
    if (!process.env.AZURE_SPEECH_KEY && !process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: "stt_not_configured" });
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length < 1000) return res.status(400).json({ error: "no_audio" });
    const seconds = Math.max(0, (audio.length - 44) / 32000); // 16 kHz * 16-bit mono
    if (seconds > 60) return res.status(413).json({ error: "audio_too_long" });
    const lang = ["en-US", "auto"].includes(req.query.lang) ? req.query.lang : "fil-PH";
    const language = lang === "en-US" ? "en-US" : "fil-PH"; // Azure needs a fixed language
    const reserved = Math.ceil(seconds * 15); // roughly what that much speech costs as text
    try {
      if (!(await reserveChars(req, res, reserved))) return;

      // ElevenLabs Scribe v2 understands Tagalog and Taglish far better than Azure's fil-PH model,
      // and the Creator plan includes 100 hours a month. Azure stays as the backup.
      if (process.env.ELEVENLABS_API_KEY) {
        try {
          const form = new FormData();
          form.append("model_id", process.env.ELEVENLABS_STT_MODEL || "scribe_v2");
          if (lang !== "auto") form.append("language_code", lang === "en-US" ? "en" : "fil");
          form.append("tag_audio_events", "false");
          form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
          const r = await fetch(`${ELEVEN_API}/v1/speech-to-text`, {
            method: "POST",
            headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
            body: form,
          });
          if (!r.ok) {
            const detail = await r.text();
            throw new Error(`scribe_${r.status}: ${detail.slice(0, 300)}${elevenHint(r.status, detail)}`);
          }
          const data = await r.json();
          const text = String(data.text || "").replace(/\s+/g, " ").trim();
          await settleChars(req, reserved, text.length, "stt");
          logTranslationUsage(req.userId, ["stt"], [false], "stt", lang, lang, "stt");
          return res.json({ text, status: "Success", engine: "elevenlabs" });
        } catch (err) {
          console.error("[premium-stt] ElevenLabs Scribe failed, using Azure:", err.message);
          if (!process.env.AZURE_SPEECH_KEY) throw err;
        }
      }

      const region = process.env.AZURE_SPEECH_REGION || "eastus";
      const response = await fetch(
        `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${language}&format=simple&profanity=raw`,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
            "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
            Accept: "application/json",
          },
          body: audio,
        }
      );
      if (!response.ok) throw new Error(`azure_stt_${response.status}: ${await response.text()}`);
      const data = await response.json();
      const text = data.RecognitionStatus === "Success" ? String(data.DisplayText || "").trim() : "";
      await settleChars(req, reserved, text.length, "stt");
      logTranslationUsage(req.userId, ["stt"], [false], "stt", language, language, "stt");
      res.json({ text, status: data.RecognitionStatus || "Unknown" });
    } catch (err) {
      console.error("[premium-stt] error:", err.message);
      res.status(502).json({ error: "stt_unavailable" });
    }
  });

  // --- 2. Thea, the AI tutor -----------------------------------------------------------
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

You are Thea, Hari's warm, encouraging Tagalog tutor. The learner is ${level}.
${mode === "roleplay"
    ? `You are role-playing this situation with them: "${scenario || "ordering food at a carinderia"}". Stay in character as the other person in the scene, keep the scene moving, and keep your lines short and realistic.`
    : "Have a natural conversation that helps them practice. Ask one follow-up question each turn to keep them talking."}
Talk the way people do out loud: usually one to three short sentences per reply, so it is easy to listen to and reply to. Go longer only when the learner asks you to explain something.
Language mix: beginner = mostly simple Tagalog with English support; intermediate = mostly Tagalog with light Taglish; advanced = natural Tagalog/Taglish like a Manila local.
${savedWords.length ? `Naturally reuse some of the learner's saved words when it fits: ${savedWords.join(", ")}.` : ""}
${mistakes.length ? `They have recently struggled with: ${mistakes.join("; ")}. Gently create chances to practice these.` : ""}
Corrections are ONLY about the learner's latest message. Each "original" must quote words that actually appear in that latest message. Never repeat corrections from earlier turns, and never correct English. If the latest message has no Tagalog mistakes, return an empty corrections list.
If the learner's latest message is mostly English (for example they didn't know how to say it in Tagalog), fill "tagalogVersion" with how a native speaker would naturally say that same message in Tagalog/Taglish at their level, so they learn to say it themselves next time. Otherwise leave it empty.

Return JSON:
{
  "reply": string (your next line, in Tagalog/Taglish appropriate to their level),
  "replyEnglish": string (English translation of reply),
  "corrections": [{ "original": string (exact words from the latest message), "corrected": string, "explanation": string (short, English) }],
  "tagalogVersion": { "tagalog": string, "note": string (short English note on a key word or pattern, or "") } (or { "tagalog": "", "note": "" } if the message was Tagalog),
  "tip": string (optional one-sentence grammar or culture tip in English, or ""),
  "suggestedReplies": [string] (2-3 short Tagalog things the learner could say next)
}`;
    const inChars = system.length / 4 + history.reduce((n, m) => n + m.content.length, 0);
    return {
      system, user: null, history, maxTokens: 700, temperature: 0.8, inChars: Math.ceil(inChars),
      clean: (d) => ({
        reply: String(d.reply || ""),
        replyEnglish: String(d.replyEnglish || ""),
        corrections: correctionsFor(history[history.length - 1].content, d.corrections),
        // the model is asked for { tagalog, note } but sometimes answers with just the string
        tagalogVersion: typeof d.tagalogVersion === "string" && d.tagalogVersion.trim()
          ? { tagalog: d.tagalogVersion.trim(), note: "" }
          : d.tagalogVersion && d.tagalogVersion.tagalog
            ? { tagalog: String(d.tagalogVersion.tagalog), note: String(d.tagalogVersion.note || "") }
            : null,
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

  // --- 6. Say It Like a Native ---------------------------------------------------------
  app.post("/premium/say-it", ...guard, llmLimiter, llmRoute("sayit", (req) => {
    const text = clampStr(req.body.text, 500);
    const context = clampStr(req.body.context, 200);
    if (!text) throw new Error("text is required");
    const system = `${TAGALOG_EXPERT}
The learner wants to express something in natural Filipino. Give how native speakers would actually say it, not a literal translation.
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
    const lines = clampList(req.body.lines, 24, (l) => {
      const text = clampStr(l?.text, 300);
      return text ? { id: clampStr(String(l.id ?? ""), 40), text } : null;
    });
    if (!lines.length) throw new Error("lines are required");
    const level = normLevel(req.body.level);
    const system = `${TAGALOG_EXPERT}
You are subtitling a video for a ${level} Tagalog learner. For each caption line: if it is English, give a natural spoken Tagalog/Taglish version (how a native speaker would say it on screen); if it is Tagalog, keep it and clean up obvious caption errors. Always also give English.
Return JSON: { "lines": [{ "id": string, "tl": string, "en": string, "note": string (short English note on slang/idiom/grammar worth knowing, or "") }] }`;
    const user = JSON.stringify(lines);
    return {
      system, user, maxTokens: 3600, temperature: 0.3, inChars: Math.ceil(system.length / 4 + user.length),
      clean: (d) => ({ lines: Array.isArray(d.lines) ? d.lines : [] }),
    };
  }));
  // --- 7. Shadowing Coach -------------------------------------------------------------------
  // Score: Azure pronunciation assessment when it grades the language, otherwise a word-by-word
  // comparison of what ElevenLabs Scribe heard (with timings for pace) against the target line.
  app.post("/premium/shadow/score", requireAuth, wavBody, requirePremium, sttLimiter, async (req, res) => {
    const target = clampStr(req.query.text, 300);
    if (!targetWords(target).length) return res.status(400).json({ error: "text_required" });
    if (!process.env.AZURE_SPEECH_KEY && !process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: "stt_not_configured" });
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length < 1000) return res.status(400).json({ error: "no_audio" });
    const seconds = Math.max(0, (audio.length - 44) / 32000);
    if (seconds > 30) return res.status(413).json({ error: "audio_too_long" });
    const reserved = Math.ceil(seconds * 15);
    try {
      if (!(await reserveChars(req, res, reserved))) return;
      let result = null;
      const region = process.env.AZURE_SPEECH_REGION || "eastus";

      // What was actually said (ElevenLabs Scribe, with word timings) and Azure's pronunciation
      // assessment run side by side; Azure's scores never exceed what the transcript supports.
      const scribe = async () => {
        if (!process.env.ELEVENLABS_API_KEY) return null;
        try {
          const form = new FormData();
          form.append("model_id", process.env.ELEVENLABS_STT_MODEL || "scribe_v2");
          form.append("language_code", "fil");
          form.append("tag_audio_events", "false");
          form.append("timestamps_granularity", "word");
          form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
          const r = await fetch(`${ELEVEN_API}/v1/speech-to-text`, { method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, body: form });
          if (!r.ok) throw new Error(`scribe_${r.status}: ${(await r.text()).slice(0, 200)}`);
          const data = await r.json();
          const words = Array.isArray(data.words) ? data.words.filter((w) => !w.type || w.type === "word") : null;
          return scoreFromTranscript(target, words, data.text);
        } catch (err) {
          console.error("[premium-shadow] Scribe failed:", err.message);
          return null;
        }
      };
      const azure = async () => {
        if (!process.env.AZURE_SPEECH_KEY || process.env.PREMIUM_PRON_ASSESS === "off") return null;
        try {
          const config = { ReferenceText: target, GradingSystem: "HundredMark", Granularity: "Word", Dimension: "Comprehensive", EnableMiscue: "True", EnableProsodyAssessment: "True" };
          const r = await fetch(
            `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=fil-PH&format=detailed`,
            {
              method: "POST",
              headers: {
                "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
                "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
                "Pronunciation-Assessment": Buffer.from(JSON.stringify(config)).toString("base64"),
                Accept: "application/json",
              },
              body: audio,
            }
          );
          if (!r.ok) {
            console.warn("[premium-shadow] Azure assessment", r.status, (await r.text()).slice(0, 200));
            return null;
          }
          return scoreFromAzure(target, await r.json());
        } catch (err) {
          console.warn("[premium-shadow] Azure assessment failed:", err.message);
          return null;
        }
      };
      const [heard, assessed] = await Promise.all([scribe(), azure()]);
      if (assessed) {
        // without Scribe, Azure's own recognized words are the check
        const check = heard || scoreFromTranscript(target, null, assessed.lexical);
        result = capByTranscript(assessed, check);
        result.engine = heard ? "azure+elevenlabs" : "azure";
      } else if (heard) {
        result = heard;
        result.engine = "elevenlabs";
      }
      if (result) delete result.lexical;

      if (!result && process.env.AZURE_SPEECH_KEY) {
        const r = await fetch(
          `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=fil-PH&format=simple&profanity=raw`,
          { method: "POST", headers: { "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY, "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000", Accept: "application/json" }, body: audio }
        );
        if (!r.ok) throw new Error(`azure_stt_${r.status}`);
        const data = await r.json();
        result = scoreFromTranscript(target, null, data.RecognitionStatus === "Success" ? data.DisplayText : "");
        result.engine = "azure-text";
      }
      if (!result) throw new Error("no_engine");
      await settleChars(req, reserved, 0, "shadow");
      logTranslationUsage(req.userId, ["shadow"], [false], "shadow", "fil", "fil", "stt");
      res.json(result);
    } catch (err) {
      console.error("[premium-shadow] error:", err.message);
      res.status(502).json({ error: "shadow_unavailable" });
    }
  });

  // Stress and syllable guide for a line (one LLM call per distinct line, then cached).
  const shadowGuideCache = new AudioCache(500);
  const guideKey = (text) => plainWord(text) ? text.toLowerCase().replace(/\s+/g, " ").trim() : "";
  app.post("/premium/shadow/guide", ...guard, llmLimiter, (req, res, next) => {
    const hit = shadowGuideCache.get(guideKey(clampStr(req.body.text, 300)));
    if (hit) return res.json(hit);
    next();
  }, llmRoute("shadowguide", (req) => {
    const text = clampStr(req.body.text, 300).replace(/\s+/g, " ");
    const words = targetWords(text).slice(0, 30);
    if (!words.length) throw new Error("text is required");
    const system = `${TAGALOG_EXPERT}
The learner will repeat this line out loud. Describe how each word is pronounced in standard Manila Tagalog.
Return JSON:
{
  "meaning": string (natural English translation),
  "words": [{
    "word": string (exactly as given, same order),
    "syllables": [string] (Tagalog syllables of the word as spelled, e.g. ["ka","i","bi","gan"]),
    "stress": number (0-based index of the stressed syllable),
    "glottal": boolean (true if the word ends in a glottal stop, e.g. "bata" child, "hindi"),
    "note": string (short English tip if this word is commonly mispronounced by English speakers, or "")
  }],
  "tip": string (one short English sentence on the hardest part of saying this line naturally)
}
Stress changes meaning in Tagalog (BU-kas "open" vs bu-KAS "tomorrow"), so use the stress that fits this sentence.`;
    const user = JSON.stringify({ line: text, words });
    return {
      system, user, maxTokens: Math.min(2600, 400 + words.length * 90), temperature: 0.2, inChars: Math.ceil(system.length / 4 + user.length),
      clean: (d) => {
        const out = {
          meaning: clampStr(d.meaning, 400),
          tip: clampStr(d.tip, 300),
          words: words.map((w, i) => {
            const g = Array.isArray(d.words) ? (d.words.find((x) => x && plainWord(x.word) === plainWord(w)) || d.words[i]) : null;
            const syllables = g && Array.isArray(g.syllables) ? g.syllables.map((x) => clampStr(String(x), 12)).filter(Boolean).slice(0, 12) : [];
            const stress = g && Number.isInteger(g.stress) && g.stress >= 0 && g.stress < syllables.length ? g.stress : Math.max(0, syllables.length - 2);
            return { word: w, syllables: syllables.length ? syllables : [w], stress: syllables.length ? stress : 0, glottal: !!(g && g.glottal), note: g ? clampStr(g.note, 200) : "" };
          }),
        };
        shadowGuideCache.set(guideKey(text), out);
        return out;
      },
    };
  }));

  // --- 8. Reading Level Meter: today's Tagalog articles (scored for readability on the device) --
  let articleCache = { at: 0, items: [] };
  const readingLimiter = makeUserLimiter(60_000, 20);
  app.post("/premium/reading/articles", ...guard, readingLimiter, async (req, res) => {
    try {
      if (Date.now() - articleCache.at > 30 * 60_000 || !articleCache.items.length) {
        const lists = await Promise.all(TAGALOG_FEEDS.map(async (f) => {
          try {
            const r = await fetch(f.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; HariReader/1.0)" }, signal: AbortSignal.timeout(10000) });
            return r.ok ? parseFeed(await r.text(), f.source).map((a) => ({ ...a, topic: f.topic })) : [];
          } catch (err) {
            console.warn("[premium-reading] feed failed:", f.source, err.message);
            return [];
          }
        }));
        const seen = new Set();
        const perTopic = {};
        const items = [];
        for (const a of lists.flat()) {
          const key = a.link.split("?")[0];
          if (seen.has(key)) continue;
          seen.add(key);
          if (a.topic === "stories" && STUDY_GUIDE.test(a.title)) continue;
          (perTopic[a.topic] = perTopic[a.topic] || []).push(a);
        }
        for (const list of Object.values(perTopic)) items.push(...list.sort((a, b) => b.date - a.date).slice(0, ARTICLES_PER_TOPIC[list[0].topic] || 12));
        if (items.length) articleCache = { at: Date.now(), items };
      }
      res.json({ articles: articleCache.items });
    } catch (err) {
      console.error("[premium-reading] error:", err.message);
      res.status(502).json({ error: "reading_unavailable" });
    }
  });

  // --- 9. Look up a Tagalog word as used in a sentence (Reading Level Meter articles and
  // learning mode on pages that are already in Tagalog). The /dictionary route needs the English
  // word Hari swapped in, which a native Tagalog page doesn't have.
  const lookupCache = new AudioCache(3000);
  const lookupKey = (req) => `${clampStr(req.body.word, 60).toLowerCase()}|${clampStr(req.body.context, 160).toLowerCase()}`;
  app.post("/premium/lookup", ...guard, llmLimiter, (req, res, next) => {
    const hit = lookupCache.get(lookupKey(req));
    if (hit) return res.json(hit);
    next();
  }, llmRoute("lookup", (req) => {
    const word = clampStr(req.body.word, 60);
    const context = clampStr(req.body.context, 400);
    if (!plainWord(word)) throw new Error("word is required");
    const key = lookupKey(req);
    const system = `${TAGALOG_EXPERT}
Explain a Tagalog word for a learner, as it is used in the given sentence (if any).
Return JSON:
{
  "englishTranslation": string (its meaning here, short),
  "partOfSpeech": string (noun, verb, adjective, particle...),
  "pronunciation": string (syllables with the stressed one in capitals, e.g. "bu-KAS"),
  "root": string (the root word if this form is inflected, e.g. "kain" for "kumain", else ""),
  "example": { "tl": string (a short, everyday example sentence), "en": string },
  "culturalNotes": string (one short usage or grammar note in English, or ""),
  "wordBreakdown": [{ "tagalog": string, "pos": string, "english": string }] (affix and root parts if inflected, else [])
}`;
    const user = JSON.stringify({ word, sentence: context });
    return {
      system, user, maxTokens: 500, temperature: 0.2, inChars: Math.ceil(system.length / 4 + user.length),
      clean: (d) => {
        const out = {
          word,
          englishTranslation: clampStr(d.englishTranslation, 200),
          partOfSpeech: clampStr(d.partOfSpeech, 40),
          pronunciation: clampStr(d.pronunciation, 80),
          root: clampStr(d.root, 60),
          example: d.example && typeof d.example === "object" ? { tl: clampStr(d.example.tl, 200), en: clampStr(d.example.en, 200) } : null,
          culturalNotes: clampStr(d.culturalNotes, 300),
          wordBreakdown: clampList(d.wordBreakdown, 4, (b) => (b && b.tagalog ? { tagalog: clampStr(b.tagalog, 40), pos: clampStr(b.pos, 30), english: clampStr(b.english, 80) } : null)),
        };
        lookupCache.set(key, out);
        return out;
      },
    };
  }));

}

module.exports = { mountPremium, synthesize, TTS_PROVIDERS, PREMIUM_PLANS, PREMIUM_VOICES, scoreFromTranscript, scoreFromAzure, parseFeed, isTagalogText };
