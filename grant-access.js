require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function grantAccess(email) {
  if (!email) {
    console.error("Usage: node grant-access.js <user@email.com>");
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
      console.log("\nUser must sign up first before granting access.");
      process.exit(1);
    }

    const user = userResult.rows[0];
    console.log(`✓ Found user: ${user.email} (ID: ${user.id})`);

    const existingSub = await client.query(
      "SELECT id, status FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [user.id]
    );

    if (existingSub.rows.length > 0) {
      const sub = existingSub.rows[0];
      console.log(`\n⚠ User already has subscription (status: ${sub.status})`);
      
      const answer = await askQuestion("Update to active status? (y/n): ");
      if (answer.toLowerCase() !== 'y') {
        console.log("Cancelled.");
        process.exit(0);
      }

      await client.query(
        "UPDATE subscriptions SET status = 'active', current_period_end = '2099-12-31 23:59:59', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [sub.id]
      );
      console.log("✓ Subscription updated to active with lifetime access!");
    } else {
      const manualSubId = `manual_grant_${Date.now()}`;
      const farFuture = "2099-12-31 23:59:59";

      await client.query(
        "INSERT INTO subscriptions (user_id, stripe_subscription_id, status, current_period_end) VALUES ($1, $2, $3, $4)",
        [user.id, manualSubId, "active", farFuture]
      );

      console.log("\n✓ Access granted successfully!");
      console.log(`   Subscription ID: ${manualSubId}`);
      console.log(`   Status: active`);
      console.log(`   Expires: ${farFuture} (lifetime)`);
    }
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
grantAccess(email);
