// node/wallet-utils.js
import crypto from 'crypto';
import { Wallet } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const ENC_KEY_HEX = process.env.ENCRYPTION_KEY || '';
if (ENC_KEY_HEX && ENC_KEY_HEX.length !== 64) {
  // warn in dev; in prod use KMS
}

export function generateWallet() {
  const w = Wallet.createRandom();
  return { address: w.address, privateKey: w.privateKey };
}

export function encryptPrivateKey(privateKey, hexKey = ENC_KEY_HEX) {
  const key = Buffer.from(hexKey.replace(/^0x/, ''), 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

export function decryptPrivateKey(ciphertextB64, ivB64, tagB64, hexKey = ENC_KEY_HEX) {
  const key = Buffer.from(hexKey.replace(/^0x/, ''), 'hex');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(ciphertextB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
