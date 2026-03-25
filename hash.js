const crypto = require("crypto");

function simpleHash(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

module.exports = { simpleHash };
