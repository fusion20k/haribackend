require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function migrateTimestamps() {
  console.log("🕐 Starting timestamp migration to EST...\n");

  const client = await pool.connect();
  try {
    console.log("Migrating users table...");
    const usersResult = await client.query(`
      UPDATE users 
      SET created_at = created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'
      WHERE created_at IS NOT NULL
    `);
    console.log(`✓ Updated ${usersResult.rowCount} user records\n`);

    console.log("Migrating subscriptions table...");
    const subsCreatedResult = await client.query(`
      UPDATE subscriptions 
      SET created_at = created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'
      WHERE created_at IS NOT NULL
    `);
    console.log(`✓ Updated ${subsCreatedResult.rowCount} subscription created_at records`);

    const subsUpdatedResult = await client.query(`
      UPDATE subscriptions 
      SET updated_at = updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'
      WHERE updated_at IS NOT NULL
    `);
    console.log(`✓ Updated ${subsUpdatedResult.rowCount} subscription updated_at records\n`);

    console.log("Migrating translations table...");
    const translationsResult = await client.query(`
      UPDATE translations 
      SET created_at = created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'
      WHERE created_at IS NOT NULL
    `);
    console.log(`✓ Updated ${translationsResult.rowCount} translation records\n`);

    const subsEndResult = await client.query(`
      UPDATE subscriptions 
      SET current_period_end = current_period_end AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York'
      WHERE current_period_end IS NOT NULL
    `);
    console.log(`✓ Updated ${subsEndResult.rowCount} subscription period end records\n`);

    console.log("✅ Migration completed successfully!");
    console.log("All timestamps have been converted from UTC to EST (America/New_York)");

  } catch (error) {
    console.error("❌ Migration error:", error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

console.log("=".repeat(60));
console.log("TIMESTAMP MIGRATION: UTC → EST (America/New_York)");
console.log("=".repeat(60));
console.log("\nThis will convert all existing timestamps in the database.");
console.log("Tables affected: users, subscriptions, translations\n");

const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout,
});

readline.question("Proceed with migration? (y/n): ", (answer) => {
  readline.close();
  
  if (answer.toLowerCase() === 'y') {
    migrateTimestamps()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("Migration failed:", error);
        process.exit(1);
      });
  } else {
    console.log("Migration cancelled.");
    process.exit(0);
  }
});
