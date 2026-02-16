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

function makeBackendKey(sourceLang, targetLang, originalText, domain = "default") {
  const normalized = originalText.trim().replace(/\s+/g, " ");
  const hash = simpleHash(normalized);
  return `${sourceLang}:${targetLang}:${domain}:${hash}`;
}

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS translations (
        id SERIAL PRIMARY KEY,
        key VARCHAR(255) NOT NULL,
        source_lang VARCHAR(10) NOT NULL,
        target_lang VARCHAR(10) NOT NULL,
        original_text TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        hit_count INTEGER DEFAULT 0,
        domain VARCHAR(255) DEFAULT 'default' NOT NULL
      )
    `);

    await client.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'translations' AND column_name = 'domain'
        ) THEN
          ALTER TABLE translations ADD COLUMN domain VARCHAR(255) DEFAULT 'default' NOT NULL;
        END IF;
      END $$;
    `);

    await client.query(`
      DROP INDEX IF EXISTS idx_translations_key
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_translations_key_domain ON translations(key, domain)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_translations_domain ON translations(domain)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        stripe_customer_id VARCHAR(255),
        has_access BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)
    `);

    await client.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = 'has_access'
        ) THEN
          ALTER TABLE users ADD COLUMN has_access BOOLEAN DEFAULT FALSE;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) NOT NULL,
        current_period_end TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_id ON subscriptions(stripe_subscription_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS translation_usage (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        segment_text TEXT NOT NULL,
        source_lang VARCHAR(10) NOT NULL,
        target_lang VARCHAR(10) NOT NULL,
        domain VARCHAR(255) NOT NULL,
        was_cache_hit BOOLEAN NOT NULL,
        character_count INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_usage_user_id ON translation_usage(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_usage_domain ON translation_usage(domain)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_usage_created_at ON translation_usage(created_at)
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
      const offset = i * 6;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`
      );
      values.push(
        row.key,
        row.source_lang,
        row.target_lang,
        row.original_text,
        row.translated_text,
        row.domain || "default"
      );
    });

    const query = `
      INSERT INTO translations (key, source_lang, target_lang, original_text, translated_text, domain)
      VALUES ${placeholders.join(", ")}
      ON CONFLICT (key, domain) DO NOTHING
    `;

    await client.query(query, values);
    console.log(`Inserted ${rows.length} new translations into cache`);
  } catch (error) {
    console.error("Error inserting translations:", error);
  } finally {
    client.release();
  }
}

async function getUserById(userId) {
  if (!process.env.DATABASE_URL) return null;

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT id, email, password_hash, stripe_customer_id, has_access, created_at FROM users WHERE id = $1",
      [userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Error getting user by ID:", error);
    return null;
  } finally {
    client.release();
  }
}

async function getUserByEmail(email) {
  if (!process.env.DATABASE_URL) return null;

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT id, email, password_hash, stripe_customer_id, has_access, created_at FROM users WHERE email = $1",
      [email]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Error getting user by email:", error);
    return null;
  } finally {
    client.release();
  }
}

async function createUser(email, passwordHash, stripeCustomerId = null) {
  if (!process.env.DATABASE_URL) throw new Error("Database not configured");

  const client = await pool.connect();
  try {
    const result = await client.query(
      "INSERT INTO users (email, password_hash, stripe_customer_id) VALUES ($1, $2, $3) RETURNING id, email, stripe_customer_id, created_at",
      [email, passwordHash, stripeCustomerId]
    );
    return result.rows[0];
  } catch (error) {
    console.error("Error creating user:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function updateUserStripeCustomerId(userId, stripeCustomerId) {
  if (!process.env.DATABASE_URL) throw new Error("Database not configured");

  const client = await pool.connect();
  try {
    await client.query(
      "UPDATE users SET stripe_customer_id = $1 WHERE id = $2",
      [stripeCustomerId, userId]
    );
  } catch (error) {
    console.error("Error updating Stripe customer ID:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function getLatestSubscriptionForUser(userId) {
  if (!process.env.DATABASE_URL) return null;

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT id, user_id, stripe_subscription_id, status, current_period_end, created_at, updated_at FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Error getting subscription for user:", error);
    return null;
  } finally {
    client.release();
  }
}

async function createSubscription(userId, stripeSubscriptionId, status, currentPeriodEnd) {
  if (!process.env.DATABASE_URL) throw new Error("Database not configured");

  const client = await pool.connect();
  try {
    const result = await client.query(
      "INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_end) VALUES ($1, $2, $3, $4) RETURNING id, user_id, stripe_subscription_id, status, current_period_end, created_at, updated_at",
      [userId, stripeSubscriptionId, status, currentPeriodEnd]
    );
    return result.rows[0];
  } catch (error) {
    console.error("Error creating subscription:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function updateSubscription(stripeSubscriptionId, status, currentPeriodEnd) {
  if (!process.env.DATABASE_URL) throw new Error("Database not configured");

  const client = await pool.connect();
  try {
    const result = await client.query(
      "UPDATE subscriptions SET status = $1, current_period_end = $2, updated_at = CURRENT_TIMESTAMP WHERE stripe_subscription_id = $3 RETURNING id, user_id, stripe_subscription_id, status, current_period_end, created_at, updated_at",
      [status, currentPeriodEnd, stripeSubscriptionId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Error updating subscription:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function getSubscriptionByStripeId(stripeSubscriptionId) {
  if (!process.env.DATABASE_URL) return null;

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT id, user_id, stripe_subscription_id, status, current_period_end, created_at, updated_at FROM subscriptions WHERE stripe_subscription_id = $1",
      [stripeSubscriptionId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Error getting subscription by Stripe ID:", error);
    return null;
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
  getUserById,
  getUserByEmail,
  createUser,
  updateUserStripeCustomerId,
  getLatestSubscriptionForUser,
  createSubscription,
  updateSubscription,
  getSubscriptionByStripeId,
};
