function normalizeSegment(text) {
  if (typeof text !== "string") {
    return "";
  }
  
  return text.trim().replace(/\s+/g, " ");
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

module.exports = {
  normalizeSegment,
  isUIString,
  splitIntoSegments,
  segmentBatch,
  validateSegment,
};
