require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
});

async function createESTView() {
  console.log("Connecting to database...\n");
  const client = await pool.connect();
  try {
    console.log("Creating translations_est view...\n");
    
    await client.query(`
      CREATE OR REPLACE VIEW translations_est AS
      SELECT 
        id,
        key,
        source_lang,
        target_lang,
        original_text,
        translated_text,
        created_at AT TIME ZONE 'America/New_York' as created_at_est,
        created_at as created_at_utc,
        hit_count
      FROM translations
      ORDER BY created_at DESC;
    `);
    
    console.log("✅ View created successfully!");
    console.log("\nIn Supabase, query this view to see EST times:");
    console.log("SELECT * FROM translations_est;\n");
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error("Stack:", error.stack);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

createESTView()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
