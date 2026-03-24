const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
});

async function logTranslationUsage(userId, segments, hitStatuses, domain, sourceLang, targetLang) {
  if (!process.env.DATABASE_URL) {
    return;
  }

  if (!Array.isArray(segments) || segments.length === 0) {
    return;
  }

  if (!Array.isArray(hitStatuses) || hitStatuses.length !== segments.length) {
    console.warn("Segment count mismatch in analytics logging");
    return;
  }

  setImmediate(async () => {
    const client = await pool.connect();
    try {
      const values = [];
      const placeholders = [];

      segments.forEach((segment, i) => {
        const offset = i * 7;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`
        );
        values.push(
          userId,
          segment,
          sourceLang,
          targetLang,
          domain,
          hitStatuses[i],
          segment.length
        );
      });

      const query = `
        INSERT INTO translation_usage (user_id, segment_text, source_lang, target_lang, domain, was_cache_hit, character_count)
        VALUES ${placeholders.join(", ")}
      `;

      await client.query(query, values);
    } catch (error) {
      console.error("Analytics logging error (non-blocking):", error.message);
    } finally {
      client.release();
    }
  });
}

async function getCacheHitRateByDomain(domain, daysBack = 7) {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      SELECT 
        COUNT(*) as total_requests,
        SUM(CASE WHEN was_cache_hit THEN 1 ELSE 0 END) as cache_hits,
        ROUND(100.0 * SUM(CASE WHEN was_cache_hit THEN 1 ELSE 0 END) / COUNT(*), 2) as hit_rate
      FROM translation_usage
      WHERE domain = $1 
        AND created_at > NOW() - INTERVAL '${daysBack} days'
      `,
      [domain]
    );
    return result.rows[0];
  } catch (error) {
    console.error("Error fetching cache hit rate:", error);
    return null;
  } finally {
    client.release();
  }
}

async function getTopSegmentsByDomain(domain, limit = 20) {
  if (!process.env.DATABASE_URL) {
    return [];
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      SELECT 
        segment_text,
        source_lang,
        target_lang,
        COUNT(*) as usage_count,
        SUM(CASE WHEN was_cache_hit THEN 1 ELSE 0 END) as cache_hit_count
      FROM translation_usage
      WHERE domain = $1
      GROUP BY segment_text, source_lang, target_lang
      ORDER BY usage_count DESC
      LIMIT $2
      `,
      [domain, limit]
    );
    return result.rows;
  } catch (error) {
    console.error("Error fetching top segments:", error);
    return [];
  } finally {
    client.release();
  }
}

async function getOverallStats(daysBack = 7) {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT
        COUNT(*) AS total_chunks,
        SUM(CASE WHEN was_cache_hit THEN 1 ELSE 0 END) AS cache_hits,
        SUM(CASE WHEN NOT was_cache_hit THEN 1 ELSE 0 END) AS mt_calls,
        ROUND(
          100.0 * SUM(CASE WHEN was_cache_hit THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0),
          2
        ) AS hit_rate_pct,
        ROUND(AVG(CASE WHEN NOT was_cache_hit THEN character_count END), 0) AS avg_chars_per_mt_call,
        COUNT(DISTINCT domain) AS unique_domains,
        COUNT(DISTINCT user_id) AS unique_users
      FROM translation_usage
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
    `, [daysBack]);

    return result.rows[0];
  } catch (error) {
    console.error("Error fetching overall stats:", error);
    return null;
  } finally {
    client.release();
  }
}

async function getStatsByDomain(daysBack = 7) {
  if (!process.env.DATABASE_URL) {
    return [];
  }

  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT
        domain,
        COUNT(*) AS total_chunks,
        SUM(CASE WHEN was_cache_hit THEN 1 ELSE 0 END) AS cache_hits,
        SUM(CASE WHEN NOT was_cache_hit THEN 1 ELSE 0 END) AS mt_calls,
        ROUND(
          100.0 * SUM(CASE WHEN was_cache_hit THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0),
          2
        ) AS hit_rate_pct,
        ROUND(AVG(CASE WHEN NOT was_cache_hit THEN character_count END), 0) AS avg_chars_per_mt_call
      FROM translation_usage
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY domain
      ORDER BY total_chunks DESC
    `, [daysBack]);

    return result.rows;
  } catch (error) {
    console.error("Error fetching stats by domain:", error);
    return [];
  } finally {
    client.release();
  }
}

async function getMonthlyUsage() {
  const total = parseInt(process.env.MONTHLY_CHAR_LIMIT) || 10000000;

  if (!process.env.DATABASE_URL) {
    return { used: 0, total, percentage: 0 };
  }

  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT COALESCE(SUM(character_count), 0) AS used
      FROM translation_usage
      WHERE was_cache_hit = false
        AND created_at >= date_trunc('month', NOW())
    `);

    const used = parseInt(result.rows[0].used) || 0;
    const percentage = parseFloat(((used / total) * 100).toFixed(2));

    return { used, total, percentage };
  } catch (error) {
    console.error("Error fetching monthly usage:", error);
    return { used: 0, total, percentage: 0 };
  } finally {
    client.release();
  }
}

module.exports = {
  logTranslationUsage,
  getCacheHitRateByDomain,
  getTopSegmentsByDomain,
  getOverallStats,
  getStatsByDomain,
  getMonthlyUsage,
};
