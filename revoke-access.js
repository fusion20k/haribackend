require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function revokeAccess(email) {
  if (!email) {
    console.error("Usage: node revoke-access.js <user@email.com>");
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const userResult = await client.query(
      "SELECT id, email FROM users WHERE email = $1",
      [email]
    );

    if (userResult.rows.length === 0) {
      console.error(`❌ User not found: ${email}`);
      process.exit(1);
    }

    const user = userResult.rows[0];
    console.log(`✓ Found user: ${user.email} (ID: ${user.id})`);

    const subResult = await client.query(
      "SELECT id, status, stripe_subscription_id FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [user.id]
    );

    if (subResult.rows.length === 0) {
      console.log("⚠ User has no subscription.");
      process.exit(0);
    }

    const sub = subResult.rows[0];
    console.log(`\nCurrent subscription:`);
    console.log(`  ID: ${sub.stripe_subscription_id}`);
    console.log(`  Status: ${sub.status}`);

    const answer = await askQuestion("\nRevoke access (set status to 'canceled')? (y/n): ");
    if (answer.toLowerCase() !== 'y') {
      console.log("Cancelled.");
      process.exit(0);
    }

    await client.query(
      "UPDATE subscriptions SET status = 'canceled', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [sub.id]
    );

    console.log("\n✓ Access revoked successfully!");
    console.log("  Status changed to: canceled");
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

function askQuestion(query) {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => readline.question(query, ans => {
    readline.close();
    resolve(ans);
  }));
}

const email = process.argv[2];
revokeAccess(email);
