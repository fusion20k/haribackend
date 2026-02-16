require("dotenv").config();
const { Pool } = require("pg");

const connectionString = "postgresql://postgres:Kraemer0513@db.wisjsfswsqtnxewhkvdl.supabase.co:5432/postgres";

console.log("Testing with:", connectionString);

const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
});

async function test() {
  try {
    const client = await pool.connect();
    console.log("✅ Connected!");
    
    const result = await client.query("SELECT NOW() as time");
    console.log("Server time (UTC):", result.rows[0].time);
    
    client.release();
    await pool.end();
  } catch (error) {
    console.error("❌ Error:", error.message);
    await pool.end();
  }
}

test();
