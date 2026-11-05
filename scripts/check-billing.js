// Characters are charged like reading a page on every Premium feature: the text the person sends
// and the Tagalog they get back, never the instructions, the conversation history or the JSON.
// Loads the real premium.js, runs each route against a fake model, and checks what lands on the
// person's allowance, what's recorded for the usage stats, and what the old counting would have cost:
//   node scripts/check-billing.js
const axios = require("axios");

process.env.AZURE_OPENAI_ENDPOINT = "https://fake";
process.env.AZURE_OPENAI_KEY = "k";
process.env.AZURE_OPENAI_DEPLOYMENT = "d";

// the model: answers shaped like the real ones, by what the instructions ask for
const REPLIES = {
  subtitles: (u) => ({ lines: JSON.parse(u).lines.map((l) => ({ id: l.id, tl: "Pupunta kami sa palengke ngayon", en: l.text, note: "A short note about a phrase in this line." })) }),
  practice: () => ({ exercises: [1, 2, 3].map(() => ({ english: "I am going to the market.", tagalog: "Pupunta ako sa palengke.", tiles: ["Pupunta", "ako", "sa", "palengke"], distractors: ["kami"], hint: "Start with the verb." })) }),
  explain: () => ({ verdict: "almost", summary: "So close, just the word order.", mistakes: [{ part: "Ako pumunta", type: "grammar", explanation: "The verb usually comes first in Tagalog." }], corrected: "Pumunta ako sa palengke.", moreNatural: [{ tagalog: "Nagpunta ako sa palengke.", note: "Also common." }], rule: "Verb first." }),
  sayit: () => ({ casual: { tagalog: "Gutom na ako.", note: "With friends." }, taglish: { tagalog: "Gutom na me.", note: "Texting." }, respectful: { tagalog: "Gutom na po ako.", note: "To elders." }, formal: { tagalog: "Ako ay nagugutom na.", note: "Writing." }, literal: { tagalog: "Ako ay gutom.", whyUnnatural: "Stiff." }, breakdown: [{ tagalog: "gutom", english: "hungry" }], culture: "Food is how Filipinos show care." }),
  shadowguide: () => ({ meaning: "Where are you going?", tip: "Stress the last syllable.", words: [{ word: "Saan", syllables: ["sa", "an"], stress: 1, glottal: false, note: "" }, { word: "ka", syllables: ["ka"], stress: 0, glottal: false, note: "" }, { word: "pupunta", syllables: ["pu", "pun", "ta"], stress: 1, glottal: false, note: "" }] }),
  lookup: () => ({ englishTranslation: "market", partOfSpeech: "noun", pronunciation: "pa-LENG-ke", root: "", example: { tl: "Pupunta ako sa palengke.", en: "I'm going to the market." }, culturalNotes: "The wet market is where most families shop.", wordBreakdown: [] }),
  read: () => ({ text: "", understood: "" }),
  tutor: () => ({ reply: "Ang galing! Ano ang binili mo sa palengke?", replyEnglish: "Nice! What did you buy at the market?", question: "", questionEnglish: "", corrections: [], tagalogVersion: null, tip: "Use po with elders.", suggestedReplies: ["Isda.", "Gulay."] }),
};
const which = (system) =>
  /subtitling a video/.test(system) ? "subtitles" : /Create \d+ \w+ exercises/.test(system) ? "practice" : /answered a/.test(system) ? "explain"
    : /wants to express something/.test(system) ? "sayit" : /will repeat this line/.test(system) ? "shadowguide" : /Explain a Tagalog word/.test(system) ? "lookup"
      : /You are Thea|tutor/i.test(system) ? "tutor" : "read";
axios.post = async (_url, body) => {
  const system = body.messages[0].content;
  const user = body.messages[body.messages.length - 1].content;
  const kind = which(system);
  const data = (REPLIES[kind] || REPLIES.read)(user);
  return { data: { choices: [{ message: { content: JSON.stringify(data) } }] } };
};

const { mountPremium } = require("../premium");

let charged = 0;
let globalUse = 0;
const recorded = [];
const pool = {
  async query(sql, params) {
    if (/INSERT INTO usage_daily/.test(sql)) recorded.push({ feature: params[1], chars: params[2] });
    return { rows: [], rowCount: 0 };
  },
};
const user = { id: 7, plan_status: "exc", stripe_customer_id: "cus_7", trial_chars_used: 0, trial_chars_limit: 1000000 };
const routes = {};
const app = { post: (p, ...h) => { routes["POST " + p] = h; }, get: (p, ...h) => { routes["GET " + p] = h; }, use() {} };
mountPremium(app, {
  requireAuth: (req, _res, next) => { req.userId = 7; next(); },
  stripe: null,
  getUserById: async () => ({ ...user }),
  resetUserCharsIfNeeded: async () => null,
  atomicCheckAndIncrementChars: async (_id, n) => { charged += n; return { allowed: true, user }; },
  incrementUserTrialChars: async (_id, n) => { charged += n; },
  insertPendingMeterEvent: async () => {},
  getUsage: async () => ({ current_month_usage_chars: 0 }),
  incrementUsage: async (n) => { globalUse += n; },
  logTranslationUsage: () => {},
  pool,
  meterPaygChars: async () => 0,
});

function call(path, body) {
  return new Promise((resolve) => {
    const handlers = routes["POST " + path];
    const req = { method: "POST", url: path, headers: {}, body, query: {}, ip: "127.0.0.1", get: () => "", socket: {}, connection: {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, data: d }); return this; }, set() { return this; }, setHeader() {}, getHeader() {}, send(d) { resolve({ status: this.statusCode, data: d }); }, end() { resolve({ status: this.statusCode }); }, on() {} };
    let i = 0;
    const next = (err) => {
      if (err) return resolve({ status: 500, error: err });
      const h = handlers[i++];
      if (h) Promise.resolve(h(req, res, next)).catch((e) => resolve({ status: 500, error: e }));
    };
    next();
  });
}

let fails = 0;
const ok = (name, cond, d = "") => { if (!cond) fails++; console.log((cond ? "pass " : "FAIL ") + name, d); };
const len = (...xs) => xs.reduce((n, x) => n + String(x).length, 0);
const settle = () => new Promise((r) => setTimeout(r, 30));

const CASES = [
  {
    name: "Thea (10th message of a chat)", path: "/premium/tutor", feature: "tutor",
    body: { level: "beginner", mode: "chat", messages: Array.from({ length: 19 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: i % 2 ? "Ang galing! Kumusta ang araw mo ngayon? Ano ang ginawa mo?" : "Mabuti naman, pumunta ako sa palengke kahapon kasama si nanay." })) },
    expect: () => len("Mabuti naman, pumunta ako sa palengke kahapon kasama si nanay.", REPLIES.tutor().reply),
  },
  {
    name: "Practice (3 exercises)", path: "/premium/practice/generate", feature: "practice",
    body: { level: "beginner", type: "builder", count: 3 },
    expect: () => 3 * len("Pupunta ako sa palengke."),
  },
  {
    name: "Explain My Mistake", path: "/premium/practice/check", feature: "explain",
    body: { level: "beginner", prompt: "I went to the market.", expected: "Pumunta ako sa palengke.", answer: "Ako pumunta sa palengke." },
    expect: () => len("Ako pumunta sa palengke.", "Pumunta ako sa palengke.", "Nagpunta ako sa palengke."),
  },
  {
    name: "Say It Like a Native", path: "/premium/say-it", feature: "sayit",
    body: { text: "I'm hungry" },
    expect: () => len("I'm hungry", "Gutom na ako.", "Gutom na me.", "Gutom na po ako.", "Ako ay nagugutom na."),
  },
  {
    name: "YouTube subtitles (20 lines)", path: "/premium/subtitles", feature: "subtitles",
    body: { level: "beginner", lines: Array.from({ length: 20 }, (_, i) => ({ id: String(i), text: "so today we're going to the market with my mom" })) },
    expect: () => 20 * len("so today we're going to the market with my mom"),
  },
  {
    name: "Shadowing Coach guide", path: "/premium/shadow/guide", feature: "shadowing",
    body: { text: "Saan ka pupunta" },
    expect: () => len("Saan ka pupunta"),
  },
  {
    name: "Word lookup", path: "/premium/lookup", feature: "lookup",
    body: { word: "palengke", context: "Pupunta kami sa palengke bukas ng umaga para bumili ng isda." },
    expect: () => len("palengke", "Pupunta ako sa palengke."),
  },
];

(async () => {
  const rows = [];
  for (const c of CASES) {
    charged = 0; globalUse = 0; recorded.length = 0;
    const r = await call(c.path, c.body);
    await settle();
    const want = c.expect();
    ok(`${c.name}: charged ${want} characters`, r.status === 200 && charged === want, r.status !== 200 ? JSON.stringify(r.error || r.data).slice(0, 200) : `charged ${charged}`);
    ok(`${c.name}: recorded under "${c.feature}"`, recorded.length === 1 && recorded[0].feature === c.feature && recorded[0].chars === want, JSON.stringify(recorded));
    rows.push([c.name, globalUse, charged]);
  }
  console.log("\nWhat one use costs the person (the old counting charged everything the model read and wrote):");
  for (const [name, before, now] of rows) console.log(`  ${name.padEnd(32)} before ~${String(before).padStart(6)}   now ${String(now).padStart(5)}   (${Math.round(before / Math.max(1, now))}x less)`);
  console.log(fails ? `\n${fails} failed` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
