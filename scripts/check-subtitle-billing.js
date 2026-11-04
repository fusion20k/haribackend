// YouTube subtitles are charged like reading: the caption text only. Runs the real /premium/subtitles
// route code from premium.js with a fake model and counts what lands on the person's allowance:
//   node scripts/check-subtitle-billing.js
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "premium.js"), "utf8").replace(/\r\n/g, "\n");
const slice = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error("premium.js changed, cannot find: " + from);
  return src.slice(a, b);
};

const helpers = slice("function clampStr(value, max) {", "function levelGuide(level) {")
  + slice("function levelGuide(level) {", "\n}\n") + "\n}\n"
  + slice("const TAGALOG_EXPERT =", ";\n") + ";\n";
const money = slice("  async function reserveChars(req, res, chars) {", "  /** PAYG: a result served from cache");
const route = slice("  function llmRoute(kind, build) {", "  const guard = [");
const subtitles = slice('app.post("/premium/subtitles", ...guard, llmLimiter, llmRoute("subtitles", ', "  // --- 7. Shadowing Coach")
  .replace('app.post("/premium/subtitles", ...guard, llmLimiter, llmRoute("subtitles", ', "const subtitlesRoute = llmRoute(\"subtitles\", ")
  .replace(/\}\)\);\s*$/, "});\n");

let charged = 0;
let globalUsage = 0;
const deps = {
  getUsage: async () => ({ current_month_usage_chars: 0 }),
  atomicCheckAndIncrementChars: async (_id, n) => { charged += n; return { allowed: true }; },
  incrementUserTrialChars: async (_id, n) => { charged += n; },
  incrementUsage: async (n) => { globalUsage += n; },
  meterPaygChars: async () => {},
  logTranslationUsage: () => {},
  // a model reply the size of a real one: every line back in Tagalog and English, with a note
  llmJson: async (_system, user) => {
    const lines = JSON.parse(user).map((l) => ({ id: l.id, tl: "Tagalog na bersyon ng linya " + l.text, en: l.text, note: "A short note about a phrase in this line." }));
    const out = JSON.stringify({ lines });
    return { data: { lines }, outChars: out.length };
  },
  crypto: require("crypto"),
};
const names = Object.keys(deps);
const make = new Function(...names, "process", "console", helpers + money + route + subtitles + "\nreturn subtitlesRoute;");
const subtitlesRoute = make(...names.map((n) => deps[n]), { env: {} }, { log() {}, error: console.error });

const caption = (i) => ({ id: String(i), text: ["so today we're going to the market with my mom", "and she wants to buy fresh fish for dinner", "it's really busy in here this morning", "okay let me show you what we got"][i % 4] });

let fails = 0;
const ok = (name, cond, d = "") => { if (!cond) fails++; console.log((cond ? "pass " : "FAIL ") + name, d); };

(async () => {
  const lines = Array.from({ length: 20 }, (_, i) => caption(i));
  const captionChars = lines.reduce((n, l) => n + l.text.length, 0);
  let sent = null;
  const res = { status() { return res; }, json(d) { sent = d; return res; } };
  await subtitlesRoute({ userId: 7, body: { level: "beginner", lines }, premiumUser: { plan_status: "exc" }, get: () => "" }, res);
  ok("the batch comes back translated", sent && sent.lines && sent.lines.length === 20);
  ok("Premium/exc is charged the caption text only", charged === captionChars, `charged ${charged} for ${captionChars} caption characters`);
  ok("the global cap still counts the full model work", globalUsage > captionChars * 3, `global ${globalUsage}`);
  console.log(`\nA 20-line batch: ${captionChars} characters charged now; before, about ${globalUsage} were.`);
  console.log(fails ? `${fails} failed` : "all passed");
  process.exitCode = fails ? 1 : 0;
})();
