const { Pool } = require("pg");

if (process.env.DATABASE_URL) {
  const urlForLog = process.env.DATABASE_URL.replace(
    /(:\/\/[^:]+:)([^@]+)(@)/,
    "$1****$3"
  );
  console.log("DATABASE_URL is set:", urlForLog);
} else {
  console.log("DATABASE_URL is NOT set");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
});

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

function makeBackendKey(sourceLang, targetLang, originalText) {
  const normalized = originalText.trim();
  const hash = simpleHash(normalized);
  return `${sourceLang}:${targetLang}:${hash}`;
}

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS translations (
        id SERIAL PRIMARY KEY,
        key VARCHAR(255) UNIQUE NOT NULL,
        source_lang VARCHAR(10) NOT NULL,
        target_lang VARCHAR(10) NOT NULL,
        original_text TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        hit_count INTEGER DEFAULT 0
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_translations_key ON translations(key)
    `);

    console.log("Database initialized successfully");
  } catch (error) {
    console.error("Database initialization error:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function findTranslationsByKeys(keys) {
  if (keys.length === 0) return [];
  if (!process.env.DATABASE_URL) return [];

  const client = await pool.connect();
  try {
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(",");
    const query = `
      SELECT key, translated_text, hit_count
      FROM translations
      WHERE key IN (${placeholders})
    `;

    const result = await client.query(query, keys);

    const updatePromises = result.rows.map((row) => {
      return client.query(
        "UPDATE translations SET hit_count = hit_count + 1 WHERE key = $1",
        [row.key]
      );
    });
    await Promise.all(updatePromises);

    return result.rows;
  } catch (error) {
    console.error("Error finding translations:", error);
    return [];
  } finally {
    client.release();
  }
}

async function insertTranslations(rows) {
  if (rows.length === 0) return;
  if (!process.env.DATABASE_URL) return;

  const client = await pool.connect();
  try {
    const values = [];
    const placeholders = [];

    rows.forEach((row, i) => {
      const offset = i * 5;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`
      );
      values.push(
        row.key,
        row.source_lang,
        row.target_lang,
        row.original_text,
        row.translated_text
      );
    });

    const query = `
      INSERT INTO translations (key, source_lang, target_lang, original_text, translated_text)
      VALUES ${placeholders.join(", ")}
      ON CONFLICT (key) DO NOTHING
    `;

    await client.query(query, values);
    console.log(`Inserted ${rows.length} new translations into cache`);
  } catch (error) {
    console.error("Error inserting translations:", error);
  } finally {
    client.release();
  }
}

module.exports = {
  initDatabase,
  findTranslationsByKeys,
  insertTranslations,
  makeBackendKey,
  simpleHash,
};
