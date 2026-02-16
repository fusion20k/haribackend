require("dotenv").config();
const { Pool } = require("pg");

console.log("DATABASE_URL:", process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
});

async function testConnection() {
  let client;
  try {
    console.log("\nAttempting to connect...");
    client = await pool.connect();
    console.log("✅ Connected!");
    
    const result = await client.query("SELECT NOW()");
    console.log("Server time:", result.rows[0].now);
    
  } catch (error) {
    console.error("❌ Connection failed:", error.message);
    console.error("Code:", error.code);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

testConnection();
