const { Pool } = require("pg");
const crypto = require("crypto");

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
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

function makeBackendKey(sourceLang, targetLang, normalizedText, domain = "default") {
  const input = `${sourceLang}|${targetLang}|${normalizedText}`;
  const hash = simpleHash(input);
  return `v2:${domain}:${hash}`;
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
        domain VARCHAR(255) DEFAULT 'default' NOT NULL,
        last_used_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
      DO $$ 
      BEGIN 
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'translations' AND column_name = 'last_used_at'
        ) THEN
          ALTER TABLE translations ADD COLUMN last_used_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
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
      CREATE INDEX IF NOT EXISTS idx_translations_last_used_at ON translations(last_used_at)
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
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'plan_status'
        ) THEN
          ALTER TABLE users ADD COLUMN plan_status TEXT;
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'trial_chars_used'
        ) THEN
          ALTER TABLE users ADD COLUMN trial_chars_used INTEGER NOT NULL DEFAULT 0;
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'trial_chars_limit'
        ) THEN
          ALTER TABLE users ADD COLUMN trial_chars_limit INTEGER NOT NULL DEFAULT 10000;
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'trial_started_at'
        ) THEN
          ALTER TABLE users ADD COLUMN trial_started_at TIMESTAMPTZ;
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'trial_converted_at'
        ) THEN
          ALTER TABLE users ADD COLUMN trial_converted_at TIMESTAMPTZ;
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'subscription_id'
        ) THEN
          ALTER TABLE users ADD COLUMN subscription_id VARCHAR(255);
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'free_chars_reset_date'
        ) THEN
          ALTER TABLE users ADD COLUMN free_chars_reset_date DATE;
        END IF;
      END $$;
    `);

    await client.query(`
      UPDATE users
      SET plan_status = 'free',
          trial_chars_limit = 25000,
          free_chars_reset_date = COALESCE(free_chars_reset_date, (NOW() + INTERVAL '30 days')::DATE)
      WHERE plan_status = 'trialing'
    `);
    console.log("Migrated trialing users to free plan");

    await client.query(`
      UPDATE users
      SET free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE
      WHERE plan_status = 'free' AND free_chars_reset_date IS NULL
    `);
    console.log("Seeded free_chars_reset_date for existing free users");

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

    const resetDay = parseInt(process.env.BILLING_RESET_DAY) || 1;
    const now = new Date();
    let nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), resetDay));
    if (nextReset <= now) {
      nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, resetDay));
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY DEFAULT 1,
        current_month_usage_chars INTEGER NOT NULL DEFAULT 0,
        usage_reset_date DATE NOT NULL
      )
    `);

    await client.query(`
      INSERT INTO usage (id, current_month_usage_chars, usage_reset_date)
      VALUES (1, 0, $1)
      ON CONFLICT (id) DO NOTHING
    `, [nextReset.toISOString().split('T')[0]]);

    const oldKeyCheck = await client.query(`
      SELECT 1 FROM translations
      WHERE key ~ '^[^:]+:[0-9a-f]{1,8}$'
      LIMIT 1
    `);
    if (oldKeyCheck.rows.length > 0) {
      await client.query(`TRUNCATE translations`);
      console.log("Cache purged: old-format (weak hash) keys detected and removed.");
    }

    const preV2KeyCheck = await client.query(`
      SELECT 1 FROM translations
      WHERE key NOT LIKE 'v2:%'
      LIMIT 1
    `);
    if (preV2KeyCheck.rows.length > 0) {
      await client.query(`DELETE FROM translations WHERE key NOT LIKE 'v2:%'`);
      console.log("Cache purged: pre-v2 keys (decorated cache entries) detected and removed.");
    }

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
    const result = await client.query(
      `SELECT key, translated_text, original_text, hit_count
       FROM translations
       WHERE key = ANY($1)`,
      [keys]
    );

    if (result.rows.length > 0) {
      const hitKeys = result.rows.map((row) => row.key);
      await client.query(
        `UPDATE translations
         SET hit_count = hit_count + 1, last_used_at = NOW()
         WHERE key = ANY($1)`,
        [hitKeys]
      );
    }

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
      ON CONFLICT (key, domain) DO UPDATE SET
        translated_text = EXCLUDED.translated_text,
        original_text = EXCLUDED.original_text,
        hit_count = 0,
        last_used_at = NOW()
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
      "SELECT id, email, password_hash, stripe_customer_id, has_access, created_at, plan_status, trial_chars_used, trial_chars_limit, trial_started_at, trial_converted_at, subscription_id, free_chars_reset_date FROM users WHERE id = $1",
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
      "SELECT id, email, password_hash, stripe_customer_id, has_access, created_at, plan_status, trial_chars_used, trial_chars_limit, trial_started_at, trial_converted_at, subscription_id, free_chars_reset_date FROM users WHERE email = $1",
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
      `INSERT INTO users (email, password_hash, stripe_customer_id, plan_status, has_access, trial_chars_limit, trial_chars_used, free_chars_reset_date)
       VALUES ($1, $2, $3, 'free', TRUE, 25000, 0, (NOW() + INTERVAL '30 days')::DATE)
       RETURNING id, email, stripe_customer_id, created_at, plan_status, has_access, trial_chars_limit, trial_chars_used, free_chars_reset_date`,
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
      `INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_end)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, user_id, stripe_subscription_id, status, current_period_end, created_at, updated_at`,
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

async function updateUserTrialStart(userId, subscriptionId) {
  if (!process.env.DATABASE_URL) throw new Error("Database not configured");

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users
       SET plan_status = 'trialing',
           trial_chars_used = CASE WHEN subscription_id = $1 THEN trial_chars_used ELSE 0 END,
           trial_chars_limit = 25000,
           trial_started_at = CASE WHEN subscription_id = $1 THEN trial_started_at ELSE NOW() END,
           subscription_id = $1,
           has_access = TRUE
       WHERE id = $2
       RETURNING id, email, plan_status, trial_chars_used, trial_chars_limit, trial_started_at, has_access`,
      [subscriptionId, userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Error updating user trial start:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function incrementUserTrialChars(userId, chars) {
  if (!process.env.DATABASE_URL) throw new Error("Database not configured");

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users
       SET trial_chars_used = trial_chars_used + $1
       WHERE id = $2
       RETURNING id, trial_chars_used, trial_chars_limit, subscription_id, plan_status`,
      [chars, userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Error incrementing trial chars:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function updateUserPlanStatus(userId, planStatus, hasAccess, convertedAt, subscriptionId) {
  if (!process.env.DATABASE_URL) throw new Error("Database not configured");

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users
       SET plan_status = $1,
           has_access = $2,
           trial_converted_at = $3,
           subscription_id = COALESCE($5, subscription_id)
       WHERE id = $4
       RETURNING id, email, plan_status, has_access, trial_converted_at, subscription_id`,
      [planStatus, hasAccess, convertedAt, userId, subscriptionId || null]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Error updating user plan status:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function cancelUserSubscription(userId) {
  if (!process.env.DATABASE_URL) throw new Error("Database not configured");

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users
       SET plan_status = 'canceled',
           has_access = FALSE
       WHERE id = $1
       RETURNING id, email, plan_status, has_access`,
      [userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Error canceling user subscription:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function resetUsageIfNeeded() {
  if (!process.env.DATABASE_URL) return null;

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT current_month_usage_chars, usage_reset_date FROM usage WHERE id = 1"
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    if (new Date() >= new Date(row.usage_reset_date)) {
      const resetDay = parseInt(process.env.BILLING_RESET_DAY) || 1;
      const now = new Date();
      let nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), resetDay));
      if (nextReset <= now) {
        nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, resetDay));
      }
      await client.query(
        "UPDATE usage SET current_month_usage_chars = 0, usage_reset_date = $1 WHERE id = 1",
        [nextReset.toISOString().split("T")[0]]
      );
      return { current_month_usage_chars: 0, usage_reset_date: nextReset.toISOString().split("T")[0] };
    }

    return row;
  } catch (error) {
    console.error("Error in resetUsageIfNeeded:", error);
    return null;
  } finally {
    client.release();
  }
}

async function resetFreeUserCharsIfNeeded(userId) {
  if (!process.env.DATABASE_URL) return null;

  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT free_chars_reset_date FROM users WHERE id = $1",
      [userId]
    );
    if (result.rows.length === 0) return null;

    const { free_chars_reset_date } = result.rows[0];
    if (!free_chars_reset_date) return null;

    if (new Date() >= new Date(free_chars_reset_date)) {
      const updated = await client.query(
        `UPDATE users
         SET trial_chars_used = 0,
             free_chars_reset_date = (NOW() + INTERVAL '30 days')::DATE
         WHERE id = $1
         RETURNING id, email, plan_status, trial_chars_used, trial_chars_limit, free_chars_reset_date, has_access, subscription_id`,
        [userId]
      );
      return updated.rows[0] || null;
    }

    return null;
  } catch (error) {
    console.error("Error in resetFreeUserCharsIfNeeded:", error);
    return null;
  } finally {
    client.release();
  }
}

async function getUsage() {
  if (!process.env.DATABASE_URL) return { current_month_usage_chars: 0 };

  const row = await resetUsageIfNeeded();
  return row || { current_month_usage_chars: 0 };
}

async function incrementUsage(chars) {
  if (!process.env.DATABASE_URL) return;

  const client = await pool.connect();
  try {
    await client.query(
      "UPDATE usage SET current_month_usage_chars = current_month_usage_chars + $1 WHERE id = 1",
      [chars]
    );
  } catch (error) {
    console.error("Error incrementing usage:", error);
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
  updateUserTrialStart,
  incrementUserTrialChars,
  updateUserPlanStatus,
  cancelUserSubscription,
  getUsage,
  incrementUsage,
  resetUsageIfNeeded,
  resetFreeUserCharsIfNeeded,
};
