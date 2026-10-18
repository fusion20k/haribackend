// Voice evaluation: renders the same Tagalog / Taglish test lines through every configured
// TTS provider so they can be compared by ear. Output: ./voice-eval/<provider>-<gender>-<n>.mp3
// Usage: node voice-eval.js            (all configured providers)
//        node voice-eval.js elevenlabs (one provider)
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { TTS_PROVIDERS } = require("./premium");

const LINES = [
  // pure Tagalog: stress, glottal stops, ng / mga
  "Magandang umaga po! Kumain na po ba kayo?",
  "Ang mga bata ay naglalaro sa labas ng bahay.",
  "Bukas, pupunta kami sa palengke para bumili ng isda.",
  "Salamat sa lahat ng tulong mo, hindi ko makakalimutan.",
  // Taglish code-switching
  "Grabe, ang traffic sa EDSA kanina, na-late tuloy ako sa meeting.",
  "Sige, I'll text you later pag tapos na yung class ko.",
  "Actually, okay lang naman, pero sana sinabi mo agad.",
  // single words (pronunciation buttons)
  "Kaibigan.",
  "Pagmamahal.",
];

const ENV_KEYS = { azure: "AZURE_SPEECH_KEY", elevenlabs: "ELEVENLABS_API_KEY", google: "GOOGLE_TTS_API_KEY" };

async function main() {
  const only = process.argv[2];
  const providers = Object.keys(TTS_PROVIDERS).filter((p) => (!only || p === only) && process.env[ENV_KEYS[p]]);
  if (!providers.length) {
    console.log("No providers configured. Set AZURE_SPEECH_KEY, ELEVENLABS_API_KEY and/or GOOGLE_TTS_API_KEY in .env");
    return;
  }
  const outDir = path.join(__dirname, "voice-eval");
  fs.mkdirSync(outDir, { recursive: true });
  for (const provider of providers) {
    for (const gender of ["female", "male"]) {
      for (let i = 0; i < LINES.length; i++) {
        const file = path.join(outDir, `${provider}-${gender}-${String(i + 1).padStart(2, "0")}.mp3`);
        try {
          const audio = await TTS_PROVIDERS[provider](LINES[i], { gender, style: "auto", rate: 1 });
          fs.writeFileSync(file, audio);
          console.log("wrote", path.basename(file), "-", LINES[i]);
        } catch (err) {
          console.error("failed", provider, gender, i + 1, err.message);
        }
      }
    }
  }
  fs.writeFileSync(path.join(outDir, "lines.txt"), LINES.map((l, i) => `${i + 1}. ${l}`).join("\n"));
  console.log(`\nDone. Listen in ${outDir} and set PREMIUM_TTS_PROVIDER to the winner.`);
}

main();
