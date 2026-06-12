// transfer-to-user.js
import { tokenContract } from './contract.js'; // contract instance with admin signer
import { getPool } from './db.js';
import dotenv from 'dotenv';
dotenv.config();

import { parseUnits } from './contract.js'; // helper to parse decimals

export async function adminTransferToUser(userId, amountDecimal) {
  const pool = await getPool();
  const [rows] = await pool.query('SELECT address FROM wallets WHERE user_id = ?', [userId]);
  if (!rows.length) throw new Error('User wallet not found');

  const toAddress = rows[0].address;
  const amountUnits = parseUnits(amountDecimal); // BigInt or string depending on ethers v6

  // send on-chain transfer
  const tx = await tokenContract.transfer(toAddress, amountUnits);
  console.log('tx sent', tx.hash);
  const receipt = await tx.wait(2); // wait 2 confirmations (configurable)
  console.log('confirmed:', receipt.transactionHash);

  // record into DB
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // insert transactions row (link to onchain hash)
    await conn.query(
      `INSERT INTO transactions (tx_uuid, user_id, from_address, to_address, amount, token_symbol, txn_type, status, onchain_tx_hash, created_at, updated_at)
       VALUES (UUID(), ?, ?, ?, ?, 'FXC', 'transfer', 'confirmed', ?, NOW(), NOW())`,
      [userId, null, toAddress, amountDecimal, receipt.transactionHash]
    );

    // update balances (credit user)
    await conn.query(
      `INSERT INTO balances (user_id, token_symbol, balance, available_balance, updated_at)
       VALUES (?, 'FXC', ?, ?, NOW())
       ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance), available_balance = available_balance + VALUES(available_balance), updated_at = NOW()`,
      [userId, amountDecimal, amountDecimal]
    );

    // Optionally subtract from admin internal balance (if tracked)
    // await conn.query(`UPDATE balances SET balance = balance - ? WHERE user_id = ? AND token_symbol='FXC'`, [amountDecimal, adminUserId]);

    await conn.query(`INSERT INTO audit_logs (admin_id, action_type, detail_json, created_at) VALUES (?, 'onchain_transfer', JSON_OBJECT('to',?, 'amount',?, 'tx', ?), NOW())`, [null, toAddress, amountDecimal, receipt.transactionHash]);

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  return receipt.transactionHash;
}
