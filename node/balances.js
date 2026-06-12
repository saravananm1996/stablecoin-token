// node/balances.js
import pool from './db.js';
import { formatUnits } from './contract.js';

/**
 * Get all balances.
 * If userId provided → that user's balances.
 * If null → all balances (for admin views or reports).
 */
export async function getBalances(userId = null) {
  try {
    if (userId) {
      // Get balances for a specific user
      const [rows] = await pool.query(
        `SELECT b.token_symbol, b.balance, b.available_balance, w.address
         FROM balances b
         LEFT JOIN wallets w ON w.user_id = b.user_id
         WHERE b.user_id = ?`,
        [userId]
      );
      return rows.map(r => ({
        token_symbol: r.token_symbol,
        balance: r.balance?.toString() || '0',
        available_balance: r.available_balance?.toString() || '0',
        address: r.address || null,
      }));
    } else {
      // Get all user balances
      const [rows] = await pool.query(
        `SELECT u.id AS user_id, u.email, w.address, b.token_symbol, b.balance, b.available_balance
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
         LEFT JOIN balances b ON b.user_id = u.id
         ORDER BY u.id`
      );
      return rows.map(r => ({
        user_id: r.user_id,
        email: r.email,
        address: r.address,
        token_symbol: r.token_symbol || 'STBL',
        balance: r.balance?.toString() || '0',
        available_balance: r.available_balance?.toString() || '0',
      }));
    }
  } catch (err) {
    console.error('Error in getBalances:', err);
    throw err;
  }
}

