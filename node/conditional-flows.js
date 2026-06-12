// node/conditional-flows.js
// Exports named functions: performMint, performTransfer
import dotenv from 'dotenv';
dotenv.config();

import { ethers } from 'ethers';
import pool from './db.js';
import { tokenContract, adminSigner, provider, parseUnits, formatUnits } from './contract.js';
import { decryptPrivateKey } from './wallet-utils.js';

const IS_LIVE = (process.env.IS_ENABLE_LIVE || 'false').toLowerCase() === 'true';
const CONFIRMATIONS = Number(process.env.CHAIN_CONFIRMATIONS || 2);

// Helper: record transaction into DB and update balances (works for DB-only & live)
export async function recordTxInDb({
  userId = null,
  fromAddr = null,
  toAddr = null,
  amountDecimal,
  txnType = 'mint',
  onchainTxHash = null,
  idempotencyKey = null
}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // idempotency check
    if (idempotencyKey) {
      const [dup] = await conn.query('SELECT id FROM transactions WHERE idempotency_key = ? LIMIT 1', [idempotencyKey]);
      if (dup.length > 0) {
        await conn.commit();
        return { existed: true, id: dup[0].id };
      }
    }

    // insert transaction
    const [ins] = await conn.query(
      `INSERT INTO transactions (tx_uuid, user_id, from_address, to_address, amount, token_symbol, txn_type, status, onchain_tx_hash, idempotency_key, created_at, updated_at)
       VALUES (UUID(), ?, ?, ?, ?, 'FXC', ?, ?, ?, ?, NOW(), NOW())`,
      [userId, fromAddr, toAddr, amountDecimal, txnType, onchainTxHash ? 'confirmed' : 'confirmed', onchainTxHash, idempotencyKey]
    );
    const txId = ins.insertId;

    // update balances (mint/transfer/burn)
    if (txnType === 'mint') {
      await conn.query(
        `INSERT INTO balances (user_id, token_symbol, balance, available_balance, updated_at)
         VALUES (?, 'FXC', ?, ?, NOW())
         ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance), available_balance = available_balance + VALUES(available_balance), updated_at = NOW()`,
        [userId, amountDecimal, amountDecimal]
      );
    } else if (txnType === 'transfer') {
      // DB-only transfers should ideally call stored proc sp_internal_transfer
      // Here we don't change balances; calling code (DB-only path) calls the proc instead
    } else if (txnType === 'burn') {
      await conn.query(
        `UPDATE balances SET balance = GREATEST(balance - ?,0), available_balance = GREATEST(available_balance - ?,0), updated_at = NOW()
         WHERE user_id = ? AND token_symbol = 'FXC'`,
        [amountDecimal, amountDecimal, userId]
      );
    }

    await conn.commit();
    return { existed: false, id: txId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Helper: wait for confirmations
async function waitForConfirmations(txResponse) {
  if (!provider) {
    // provider may be null if contract not configured
    return txResponse.wait ? await txResponse.wait(CONFIRMATIONS) : txResponse;
  }
  return await txResponse.wait(CONFIRMATIONS);
}

/**
 * performMint
 * - If IS_LIVE=false -> record mint in DB only
 * - If IS_LIVE=true  -> call tokenContract.mint (admin signer), wait confirmations, record onchain hash and update DB
 *
 * params:
 *  { toAddress, amountDecimal, userId, idempotencyKey }
 */
export async function performMint({ toAddress, amountDecimal, userId = null, idempotencyKey = null,adminId = null }) {
  if (!toAddress) throw new Error('toAddress required');
  if (!amountDecimal) throw new Error('amountDecimal required');

  // DB-only path
  if (!IS_LIVE) {
    // Use recordTxInDb which will update balances for txnType 'burn'
  // Call stored procedure sp_internal_transfer(from_user, to_user, amount, admin_id, note)
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      await c.query('CALL sp_mint(?,?,?,?,?)', [userId, toAddress,amountDecimal,adminId || null, 'Token Mint']);
      await c.commit();
      return { status: 'ok', mode: 'db-only' };
    } catch (err) {
      await c.rollback();
      throw err;
    } finally {
      c.release();
    }
  }

  // Live path
  if (!tokenContract || !adminSigner) throw new Error('Live mode requires tokenContract and adminSigner configured');

  const units = parseUnits(amountDecimal);
  const tx = await tokenContract.connect(adminSigner).mint(toAddress, units);
  const receipt = await waitForConfirmations(tx);

  // record into DB with onchain hash
  return await recordTxInDb({
    userId,
    fromAddr: null,
    toAddr: toAddress,
    amountDecimal,
    txnType: 'mint',
    onchainTxHash: receipt.transactionHash,
    idempotencyKey
  });
}

/**
 * performTransfer
 * - Handles both DB-only internal transfer (preferred) and live on-chain transfer.
 *
 * params:
 *  { fromUserId, toUserId, amountDecimal, fromAddress(optional), toAddress(optional), adminId(optional),
 *    idempotencyKey(optional), preferOnchain(boolean, default false) }
 */
export async function performTransfer({
  fromUserId,
  toUserId,
  amountDecimal,
  fromAddress = null,
  toAddress = null,
  adminId = null,
  idempotencyKey = null,
  preferOnchain = false
}) {
  if (!fromUserId && !fromAddress) throw new Error('fromUserId or fromAddress required');
  if (!toUserId && !toAddress) throw new Error('toUserId or toAddress required');
  if (!amountDecimal) throw new Error('amountDecimal required');

  // Resolve onchain addresses if not provided
  const conn = await pool.getConnection();
  try {
    if (!fromAddress && fromUserId) {
      const [r] = await conn.query('SELECT address FROM wallets WHERE user_id = ? LIMIT 1', [fromUserId]);
      if (!r.length) throw new Error('Sender wallet not found for user ' + fromUserId);
      fromAddress = r[0].address;
    }
    if (!toAddress && toUserId) {
      const [r] = await conn.query('SELECT address FROM wallets WHERE user_id = ? LIMIT 1', [toUserId]);
      if (!r.length) throw new Error('Receiver wallet not found for user ' + toUserId);
      toAddress = r[0].address;
    }
  } finally {
    conn.release();
  }

  // If DB-only or preferOnchain is false -> use DB internal transfer stored proc for atomicity
  if (!IS_LIVE || !preferOnchain) {
    // Call stored procedure sp_internal_transfer(from_user, to_user, amount, admin_id, note)
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      await c.query('CALL sp_internal_transfer(?,?,?,?,?,?,?)', [fromUserId, toUserId, amountDecimal,fromAddress,toAddress, adminId || null, 'internal transfer']);
      await c.commit();
      return { status: 'ok', mode: 'db-only' };
    } catch (err) {
      await c.rollback();
      throw err;
    } finally {
      c.release();
    }
  }

  // LIVE on-chain transfer branch:
  // Two options: sign with sender's private key (custodial) OR use adminSigner to transfer on behalf (relay)
  if (!tokenContract) throw new Error('tokenContract not loaded for live transfers');

  // Try to get sender private key from DB and decrypt it (custodial flow)
  const getConn = await pool.getConnection();
  let cipherRow;
  try {
    const [rows] = await getConn.query('SELECT encrypted_private_key, enc_iv, enc_tag FROM wallets WHERE user_id = ? LIMIT 1', [fromUserId]);
    if (!rows.length) {
      // fallback: if adminSigner should be used to relay from admin
      // we'll use adminSigner to transfer from admin to recipient and also update DB accordingly
      if (!adminSigner) throw new Error('Sender wallet not found and adminSigner not configured');
      const units = parseUnits(amountDecimal);
      const tx = await tokenContract.connect(adminSigner).transfer(toAddress, units);
      const receipt = await waitForConfirmations(tx);

      // record DB: debit fromUserId and credit toUserId (best to call sp_internal_transfer and then update transaction onchain hash)
      // We'll call sp_internal_transfer then insert transaction row linking to onchain hash
      const c2 = await pool.getConnection();
      try {
        await c2.beginTransaction();
        await c2.query('CALL sp_internal_transfer(?,?,?,?,?)', [fromUserId, toUserId, amountDecimal, adminId || null, 'relay transfer']);
        // insert tx row for audit
        await c2.query(
          `INSERT INTO transactions (tx_uuid,user_id,from_address,to_address,amount,token_symbol,txn_type,status,onchain_tx_hash,created_at,updated_at)
           VALUES (UUID(), ?, ?, ?, ?, 'FXC', 'transfer', 'confirmed', ?, NOW(), NOW())`,
          [fromUserId, fromAddress, toAddress, amountDecimal, receipt.transactionHash]
        );
        await c2.commit();
      } catch (e) {
        await c2.rollback();
        throw e;
      } finally { c2.release(); }

      return { status: 'ok', mode: 'relay-admin', txHash: receipt.transactionHash };
    }
    cipherRow = rows[0];
  } finally {
    getConn.release();
  }

  // decrypt sender private key
  const privateKey = decryptPrivateKey(cipherRow.encrypted_private_key, cipherRow.enc_iv, cipherRow.enc_tag);
  if (!privateKey) throw new Error('Failed to decrypt sender private key');

  // create signer from sender key
  const signer = new ethers.Wallet(privateKey, provider);
  const contractWithSigner = tokenContract.connect(signer);
  const units = parseUnits(amountDecimal);
  const tx = await contractWithSigner.transfer(toAddress, units);
  const receipt = await waitForConfirmations(tx);

  // After confirmation, update DB: debit and credit via sp_internal_transfer and insert transaction with onchain hash
  const c3 = await pool.getConnection();
  try {
    await c3.beginTransaction();
    await c3.query('CALL sp_internal_transfer(?,?,?,?,?)', [fromUserId, toUserId, amountDecimal, adminId || null, 'onchain user transfer']);
    await c3.query(
      `INSERT INTO transactions (tx_uuid,user_id,from_address,to_address,amount,token_symbol,txn_type,status,onchain_tx_hash,created_at,updated_at)
       VALUES (UUID(), ?, ?, ?, ?, 'FXC', 'transfer', 'confirmed', ?, NOW(), NOW())`,
      [fromUserId, fromAddress, toAddress, amountDecimal, receipt.transactionHash]
    );
    await c3.commit();
  } catch (e) {
    await c3.rollback();
    throw e;
  } finally { c3.release(); }

  return { status: 'ok', mode: 'onchain-user-signed', txHash: receipt.transactionHash };
}

/**
 * performBurn
 * - If IS_LIVE=false -> record burn in DB only (debit user's balance)
 * - If IS_LIVE=true  -> call tokenContract.burn(fromAddress, amountUnits) using adminSigner (requires MINTER_ROLE),
 *                      wait confirmations, then record onchain hash and debit DB balances.
 *
 * params:
 *  { fromAddress, amountDecimal, userId, idempotencyKey, adminId }
 */
export async function performBurn({
  fromAddress = null,
  amountDecimal,
  userId = null,
  idempotencyKey = null,
  adminId = null
}) {
  if (!amountDecimal) throw new Error('amountDecimal required');

  // DB-only path
  if (!IS_LIVE) {
    // Use recordTxInDb which will update balances for txnType 'burn'
  // Call stored procedure sp_internal_transfer(from_user, to_user, amount, admin_id, note)
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      await c.query('CALL sp_burn(?,?,?,?,?)', [userId, fromAddress,amountDecimal,adminId || null, 'Token Burn']);
      await c.commit();
      return { status: 'ok', mode: 'db-only' };
    } catch (err) {
      await c.rollback();
      throw err;
    } finally {
      c.release();
    }
  }

  // Live path: require tokenContract + adminSigner configured
  if (!tokenContract || !adminSigner) throw new Error('Live mode requires tokenContract and adminSigner configured');

  // Resolve fromAddress if not provided but userId given
  if (!fromAddress && userId) {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT address FROM wallets WHERE user_id = ? LIMIT 1', [userId]);
      if (!rows.length) throw new Error('Wallet not found for user ' + userId);
      fromAddress = rows[0].address;
    } finally {
      conn.release();
    }
  }
  if (!fromAddress) throw new Error('fromAddress (or userId) required for live burn');

  // Call on-chain burn via admin (admin must have MINTER_ROLE and contract must expose burn(address,uint256))
  const units = parseUnits(amountDecimal);
  // Some contracts expose burn(address,uint256) and some require burnFrom; adjust accordingly.
  // Using burn(fromAddress, units) as per your StableCoin.sol which had burn(address,uint256).
  const tx = await tokenContract.connect(adminSigner).burn(fromAddress, units);
  const receipt = await waitForConfirmations(tx);

  // Record into DB with onchain hash and update balances (debit)
  return await recordTxInDb({
    userId,
    fromAddr: fromAddress,
    toAddr: null,
    amountDecimal,
    txnType: 'burn',
    onchainTxHash: receipt.transactionHash,
    idempotencyKey
  });
}

