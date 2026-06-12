#!/usr/bin/env node
/**
 * Admin CLI (mint / burn)
 *
 * - Uses performMint / performBurn from conditional-flows.js when available.
 * - Falls back to DB-only direct operations if conditional functions are missing.
 *
 * Usage:
 *   node admin-cli.js mint --user_id=1 --amount=10000
 *   node admin-cli.js burn --user_id=1 --amount=500
 *   node admin-cli.js balance --user_id=1
 */

import dotenv from "dotenv";
dotenv.config();

import pool from "./db.js";

let performMint = null;
let performBurn = null;

// Try to import conditional-flows dynamically. If not found, we'll use DB-only fallback.
try {
  const mod = await import('./conditional-flows.js');
  performMint = mod.performMint ?? null;
  performBurn = mod.performBurn ?? null;
} catch (err) {
  // ignore - fallback to DB-only
}

// ---- arg parsing ----
const args = process.argv.slice(2);
const command = args[0]?.toLowerCase();
const getArg = (name, def = null) => {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.split("=")[1] : def;
};

const userId = getArg("user_id");
const amount = getArg("amount");
const idempotencyKey = getArg("idempotency_key") ?? `${command}-${userId}-${Date.now()}`;

if (!command) {
  console.log(`
Usage:
  node admin-cli.js mint --user_id=1 --amount=10000
  node admin-cli.js burn --user_id=1 --amount=500
  node admin-cli.js balance --user_id=1
`);
  process.exit(0);
}

// ---- helpers ----
async function fallbackDbMint(userId, amount, idempotencyKey) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [wallets] = await conn.query("SELECT address FROM wallets WHERE user_id=? LIMIT 1", [userId]);
    if (!wallets.length) throw new Error("Wallet not found for user_id=" + userId);
    const address = wallets[0].address;

    await conn.query(
      `INSERT INTO transactions (tx_uuid,user_id,from_address,to_address,amount,token_symbol,txn_type,status,onchain_tx_hash,idempotency_key,created_at,updated_at)
       VALUES (UUID(), ?, NULL, ?, ?, 'FXC', 'mint', 'confirmed', NULL, ?, NOW(), NOW())`,
      [userId, address, amount, idempotencyKey]
    );

    await conn.query(
      `INSERT INTO balances (user_id, token_symbol, balance, available_balance, updated_at)
       VALUES (?, 'FXC', ?, ?, NOW())
       ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance),
                               available_balance = available_balance + VALUES(available_balance),
                               updated_at = NOW()` ,
      [userId, amount, amount]
    );

    await conn.commit();

    const [newBal] = await conn.query(
      "SELECT balance FROM balances WHERE user_id=? AND token_symbol='FXC'",
      [userId]
    );
    return { mode: 'db-only', newBalance: newBal[0]?.balance ?? '0' };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function fallbackDbBurn(userId, amount, idempotencyKey) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [bal] = await conn.query(
      "SELECT balance FROM balances WHERE user_id=? AND token_symbol='FXC'",
      [userId]
    );
    const currentBal = bal[0]?.balance || 0;
    if (parseFloat(currentBal) < parseFloat(amount))
      throw new Error("Insufficient balance to burn");

    await conn.query(
      `INSERT INTO transactions (tx_uuid,user_id,from_address,to_address,amount,token_symbol,txn_type,status,onchain_tx_hash,idempotency_key,created_at,updated_at)
       VALUES (UUID(), ?, NULL, NULL, ?, 'FXC', 'burn', 'confirmed', NULL, ?, NOW(), NOW())`,
      [userId, amount, idempotencyKey]
    );

    await conn.query(
      `UPDATE balances
         SET balance = GREATEST(balance - ?, 0),
             available_balance = GREATEST(available_balance - ?, 0),
             updated_at = NOW()
       WHERE user_id = ? AND token_symbol='FXC'`,
      [amount, amount, userId]
    );

    await conn.commit();

    const [newBal] = await conn.query(
      "SELECT balance FROM balances WHERE user_id=? AND token_symbol='FXC'",
      [userId]
    );
    return { mode: 'db-only', newBalance: newBal[0]?.balance ?? '0' };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getBalance(userId) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query("SELECT balance, available_balance FROM balances WHERE user_id = ? AND token_symbol='FXC'", [userId]);
    if (!rows.length) return { balance: '0', available: '0' };
    return { balance: rows[0].balance, available: rows[0].available_balance };
  } finally {
    conn.release();
  }
}

// ---- commands ----
if (command === "balance") {
  if (!userId) {
    console.error("user_id is required for balance");
    await pool.end();
    process.exit(1);
  }
  try {
    const b = await getBalance(userId);
    console.log(`Balance for user_id=${userId}: ${b.balance} (available: ${b.available})`);
  } catch (err) {
    console.error("Error fetching balance:", err.message);
  } finally {
    await pool.end();
  }
  process.exit(0);
}

if (!userId || !amount) {
  console.error("user_id and amount are required for mint/burn");
  await pool.end();
  process.exit(1);
}

if (command === "mint") {
  try {
    if (performMint) {
      // Resolve toAddress for user
      const conn = await pool.getConnection();
      let toAddress = null;
      try {
        const [r] = await conn.query('SELECT address FROM wallets WHERE user_id = ? LIMIT 1', [userId]);
        if (!r.length) throw new Error('Wallet not found for user_id=' + userId);
        toAddress = r[0].address;
      } finally {
        conn.release();
      }

      const res = await performMint({ toAddress, amountDecimal: amount, userId, idempotencyKey });
      console.log(`✅ Mint result (via performMint):`, res);
    } else {
      const res = await fallbackDbMint(userId, amount, idempotencyKey);
      console.log(`✅ Mint result (DB fallback): new balance = ${res.newBalance}`);
    }
  } catch (err) {
    console.error("❌ Mint failed:", err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

if (command === "burn") {
  try {
    if (performBurn) {
      // Resolve fromAddress for user
      const conn = await pool.getConnection();
      let fromAddress = null;
      try {
        const [r] = await conn.query('SELECT address FROM wallets WHERE user_id = ? LIMIT 1', [userId]);
        if (!r.length) throw new Error('Wallet not found for user_id=' + userId);
        fromAddress = r[0].address;
      } finally {
        conn.release();
      }

      const res = await performBurn({ fromAddress, amountDecimal: amount, userId, idempotencyKey });
      console.log(`✅ Burn result (via performBurn):`, res);
    } else {
      const res = await fallbackDbBurn(userId, amount, idempotencyKey);
      console.log(`✅ Burn result (DB fallback): new balance = ${res.newBalance}`);
    }
  } catch (err) {
    console.error("❌ Burn failed:", err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

console.error("Invalid command. Use 'mint', 'burn' or 'balance'.");
await pool.end();
process.exit(1);
