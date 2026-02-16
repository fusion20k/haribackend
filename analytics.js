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

module.exports = {
  logTranslationUsage,
  getCacheHitRateByDomain,
  getTopSegmentsByDomain,
};
