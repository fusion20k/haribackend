const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{200D}\u{20E3}\u{FE0F}]/gu;

const PUNCT_TRIM_REGEX = /^[\s.,!?;:*#\-\u2013\u2014'"()\[\]{}]+|[\s.,!?;:*#\-\u2013\u2014'"()\[\]{}]+$/g;

function normalizeSegment(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    .replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u00A0]/g, " ")
    .replace(/[\u201C\u201D\u201E\u201F\u275D\u275E]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u275B\u275C]/g, "'")
    .replace(/\u2026/g, "...")
    .replace(/\u2013/g, "-")
    .replace(/\u2014/g, "--")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:*#\-'"()\[\]{}]+$/, "")
    .trim();
}

function isUIString(segment) {
  const normalized = normalizeSegment(segment);
  
  if (normalized.length === 0) {
    return false;
  }
  
  if (normalized.length > 50) {
    return false;
  }
  
  const sentenceEndings = /[.!?]$/;
  if (sentenceEndings.test(normalized)) {
    return false;
  }
  
  return true;
}

function splitIntoSegments(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return [];
  }
  
  const sentencePattern = /[.!?]+/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  
  while ((match = sentencePattern.exec(text)) !== null) {
    const endIndex = match.index + match[0].length;
    const segment = text.substring(lastIndex, endIndex).trim();
    
    if (segment.length > 0) {
      parts.push(segment);
    }
    
    lastIndex = endIndex;
  }
  
  const remaining = text.substring(lastIndex).trim();
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  
  return parts.filter(part => part.length > 0);
}

function segmentBatch(texts) {
  if (!Array.isArray(texts)) {
    return [];
  }
  
  const allSegments = [];
  
  texts.forEach(text => {
    const segments = splitIntoSegments(text);
    allSegments.push(...segments);
  });
  
  return allSegments;
}

function validateSegment(segment, maxLength = 1000) {
  if (typeof segment !== "string") {
    return { valid: false, error: "Segment must be a string" };
  }
  
  const normalized = normalizeSegment(segment);
  
  if (normalized.length === 0) {
    return { valid: false, error: "Segment cannot be empty" };
  }
  
  if (normalized.length > maxLength) {
    return { valid: false, error: `Segment exceeds maximum length of ${maxLength} characters` };
  }
  
  return { valid: true, normalized };
}

function stripPunctuation(text) {
  if (typeof text !== "string") return "";
  return text.replace(PUNCT_TRIM_REGEX, "");
}

function stripEmojis(text) {
  if (typeof text !== "string") return "";
  return text.replace(EMOJI_REGEX, "").replace(/\s+/g, " ").trim();
}

function cleanSegment(text) {
  if (typeof text !== "string") {
    return { original: "", cleaned: "", leadingPunct: "", trailingPunct: "", emojis: [] };
  }

  const emojis = text.match(EMOJI_REGEX) || [];

  const stripped = text.replace(EMOJI_REGEX, "");

  const leadingMatch = stripped.match(/^[\s.,!?;:*#\-\u2013\u2014'"()\[\]{}]+/);
  const trailingMatch = stripped.match(/[\s.,!?;:*#\-\u2013\u2014'"()\[\]{}]+$/);
  const leadingPunct = leadingMatch ? leadingMatch[0] : "";
  const trailingPunct = trailingMatch ? trailingMatch[0] : "";

  const cleaned = stripped
    .replace(PUNCT_TRIM_REGEX, "")
    .replace(/\s+/g, " ")
    .trim();

  return { original: text, cleaned, leadingPunct, trailingPunct, emojis };
}

function isTranslatable(cleaned) {
  if (typeof cleaned !== "string" || cleaned.length === 0) return false;
  return /[a-zA-Z]/.test(cleaned);
}

function reattachDecorations(translatedClean, decorations) {
  const { leadingPunct, trailingPunct, emojis } = decorations;
  let result = (leadingPunct || "") + translatedClean + (trailingPunct || "");
  if (emojis && emojis.length > 0) {
    result = result.trimEnd() + " " + emojis.join("") ;
  }
  return result.trim();
}

function isEchoedTranslation(cleanInput, cleanOutput) {
  if (typeof cleanInput !== "string" || typeof cleanOutput !== "string") return false;
  const normIn = cleanInput.toLowerCase().trim().replace(/\s+/g, " ");
  const normOut = cleanOutput.replace(EMOJI_REGEX, "").replace(PUNCT_TRIM_REGEX, "").toLowerCase().trim().replace(/\s+/g, " ");
  return normIn === normOut;
}

function isValidTranslation(inputText, outputText) {
  if (typeof inputText !== "string" || typeof outputText !== "string") return false;
  if (/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/.test(outputText)) return false;
  if (/\*[A-Z0-9_]+\*/.test(outputText)) return false;
  if (outputText.length > inputText.length * 8 && outputText.length > 100) return false;
  return true;
}

module.exports = {
  normalizeSegment,
  isUIString,
  splitIntoSegments,
  segmentBatch,
  validateSegment,
  stripPunctuation,
  stripEmojis,
  cleanSegment,
  isTranslatable,
  reattachDecorations,
  isEchoedTranslation,
  isValidTranslation,
};
