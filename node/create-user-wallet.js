// createUserWallet.js
import dotenv from 'dotenv';
dotenv.config();
import { generateWallet, encryptPrivateKey } from './wallet-utils.js';
import { getPool } from './db.js'; // your mysql2/promise pool
const ENC_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // must be 32 bytes hex

export async function createUserWallet(userId, notes='') {
  const { address, privateKey } = generateWallet();
  const { ciphertext, iv, tag } = encryptPrivateKey(privateKey, ENC_KEY);

  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.query(
      `INSERT INTO wallets (user_id, address, encrypted_private_key, enc_iv, enc_tag, notes)
       VALUES (?, ?, ?, UNHEX(?), UNHEX(?), ?)`,
      [userId, address, ciphertext, Buffer.from(iv, 'base64').toString('hex'), Buffer.from(tag, 'base64').toString('hex'), notes]
    );
    return { address };
  } finally {
    conn.release();
  }
}
