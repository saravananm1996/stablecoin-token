// node/server.js
import jwt from 'jsonwebtoken';
import express from 'express';
import helmet from 'helmet';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import nodemailer from "nodemailer";
import ExcelJS from 'exceljs';

dotenv.config();

import pool from './db.js';
import { requireAuth, requireAdmin } from './middleware/auth.js';

import { generateWallet, encryptPrivateKey, decryptPrivateKey } from './wallet-utils.js';
import { tokenContract, adminSigner, provider, parseUnits, formatUnits } from './contract.js';
import { performMint, performTransfer,performBurn } from './conditional-flows.js';
import { getBalances } from './balances.js';

const USE_PLAINTEXT = (process.env.USE_PLAINTEXT_PASSWORD === 'true');
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ensure upload dir exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer storage config
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    // unique filename: userId-timestamp-random-ext
    const userIdForName = (req.user && req.user.id) ? req.user.id : 'anon';
    const ts = Date.now();
    const rnd = crypto.randomBytes(4).toString('hex');
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${userIdForName}-${ts}-${rnd}${ext}`);
  }
});

function formatDateToDMY(dateStr) {
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const d = new Date(dateStr);

    const day = String(d.getDate()).padStart(2, "0");
    const month = months[d.getMonth()];
    const year = d.getFullYear();

    return `${day}-${month}-${year}`;
}

function replaceTemplate(html, data) {
  return html.replace(/{{(.*?)}}/g, (match, key) => {
    return data[key.trim()] || match;  // keep original text if missing
  });
}


function loadTemplate(fileName) {
  const templatePath = path.join(process.cwd(), "templates", fileName);
  return fs.readFileSync(templatePath, "utf8");
}



function cleanupUploads(files) {
  Object.values(files).flat().forEach(f => {
    try { fs.unlinkSync(f.path); } catch (e) {}
  });
}

// only accept images
function fileFilter (req, file, cb) {
  const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (!allowed.includes(ext)) {
    return cb(new Error('Only images are allowed (.png, .jpg, .jpeg, .webp)'));
  }
  cb(null, true);
}

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

const app = express();

app.use(cors({
  origin: true,
  methods: ['GET','HEAD','PUT','PATCH','POST','DELETE'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With','Accept'],
  credentials: false   // set to true only if you actually use cookies/sessions
}));

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },

  crossOriginEmbedderPolicy: false,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/exports', express.static(path.join(__dirname, 'public', 'exports')));


// 5) Extra safety: explicitly set CORP header for any requests that hit static files
//    (Helmet already sets CORP above, but this ensures it for all responses.)
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // Optional: add Access-Control-Allow-Origin if you want explicitly (CORS middleware already sets it)
  // res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});




// helper: generate a readable random password
function generatePassword(len = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*()-_=+';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}


/**
 * POST /api/login
 * Body: { email, password }
 * Response on success: { status: 'ok', token, user: { id, email, fullname, phone } }
 * Error: { status: 'error', message }
 */
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ status: 'error', message: 'email and password required' });

    // fetch user by email
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT users.id, email, password_hash,profile_image, fullname, phone, is_active, kyc_status,is_admin,wallets.address FROM users left join wallets on users.id = wallets.user_id WHERE email = ? LIMIT 1', [email]);
      if (!rows.length) return res.status(401).json({ status: 'error', message: 'invalid credentials' });

      const user = rows[0];

      if (!user.is_active) return res.status(403).json({ status: 'error', message: 'account disabled' });

      let passwordMatches = user.password_hash;     

      if (passwordMatches !== password) {
        return res.status(401).json({ status: 'error', message: 'invalid credentials' });
      }
      let profile_image = '';
      if(user.profile_image !== null){
          profile_image = process.env.BASE_URL+'uploads/'+user.profile_image;
      }


      // create JWT
      const tokenPayload = {
        sub: user.id,
        email: user.email,
        fullname: user.fullname,
        kyc_status: user.kyc_status,
        is_admin: user.is_admin,
        address:user.address,
        profile_image:profile_image
      };
      const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

      // respond with minimal user info + token
      return res.json({
        status: 'ok',
        token,
        user: {
          id: user.id,
          email: user.email,
          fullname: user.fullname,
          phone: user.phone,
          kyc_status: user.kyc_status,
          is_admin: user.is_admin,
          address:user.address,
          profile_image:profile_image
        }
      });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('Error in /api/login:', err);
    return res.status(500).json({ status: 'error', message: 'internal_server_error' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { fullname, email, password } = req.body;

    // Basic validation
    if (!fullname || !email || !password) {
      return res.status(400).json({
        status: 'error',
        message: 'fullname, email and password required'
      });
    }

    const conn = await pool.getConnection();
    try {
      // check email already exists
      const [exists] = await conn.query(
        'SELECT id FROM users WHERE email = ? LIMIT 1',
        [email]
      );

      if (exists.length) {
        return res.status(409).json({
          status: 'error',
          message: 'Email already registered'
        });
      }

      const verifyToken = crypto.randomBytes(32).toString("hex");

      // Store user (plain password for your example — you should hash it)
      const [result] = await conn.query(
        `INSERT INTO users (fullname, email, password_hash, is_active, kyc_status, is_admin,verification_code) 
         VALUES (?, ?, ?, 0, 'pending', 0,?)`,
        [fullname, email, password,verifyToken]  // password_hash should be hashed in real apps
      );

      const newUserId = result.insertId;
      const verifyUrl = process.env.APP_URL+'verifyEmail?token='+verifyToken;

      const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    let emailTemplate = loadTemplate("verification_email.html");

    let html = replaceTemplate(emailTemplate, {
      FULLNAME: fullname,
      VERIFY_URL: verifyUrl,
      YEAR: new Date().getFullYear(),
    });  

    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: "Verify Email",
      html: html
    })
    .then(() => console.log("Verification email sent"))
    .catch(err => console.error("Email error:", err));

     
      return res.json({
        status: 'ok',
        message: 'Registration successful. Please verify your email.',
        user_id: newUserId
      });

    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('Error in /api/register:', err);
    return res.status(500).json({
      status: 'error',
      message: 'internal_server_error'
    });
  }
});
app.get('/api/verify-email', async (req, res) => {
  const { verification_code } = req.query;

  if (!verification_code) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid token'
    });
  }

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      "SELECT id FROM users WHERE verification_code = ? LIMIT 1",
      [verification_code]
    );
   if (!rows.length) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid or expired code'
      });
    }

    const userId = rows[0].id;

    await conn.query(
      "UPDATE users SET is_active = 1, verification_code = NULL WHERE id = ?",
      [userId]
    );

    // generate wallet
    const wallet = ethers.Wallet.createRandom();
    const address = wallet.address;
    const privateKey = wallet.privateKey; // 0x...
    const mnemonic = wallet.mnemonic?.phrase || null;

    // encrypt private key
    const enc = encryptPrivateKey(privateKey);
    // enc = { ciphertext, iv, tag }

    // insert wallet row
    await conn.query(
      `INSERT INTO wallets (user_id, address, encrypted_private_key, enc_iv, enc_tag, mnemonic, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [userId, address, enc.ciphertext, enc.iv, enc.tag, mnemonic]
    );

    // initialize balances row
    await conn.query(
      `INSERT INTO balances (user_id, token_symbol, balance, available_balance, updated_at)
       VALUES (?, 'FXC', 0, 0, NOW())
       ON DUPLICATE KEY UPDATE updated_at = NOW()`,
      [userId]
    );


    return res.json({
        status: 'ok',
        message: 'Your email has been verified successfully.'
      });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', message: 'internal_server_error' });
  } finally {
    conn.release();
  }
});

app.post('/api/forgotpassword', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        status: 'error',
        message: 'email is required'
      });
    }

    const conn = await pool.getConnection();
    try {
      // Check if email exists
      const [rows] = await conn.query(
        'SELECT id, email, fullname FROM users WHERE email = ? LIMIT 1',
        [email]
      );

      if (!rows.length) {
        return res.status(404).json({
          status: 'error',
          message: 'Email not found'
        });
      }

      const user = rows[0];

      // Generate random 8-digit password
      const newPassword = generatePassword(8);

      // Update password in DB (you can hash later)
      await conn.query(
        'UPDATE users SET password_hash = ? WHERE id = ?',
        [newPassword, user.id]
      );

      const login_url = process.env.APP_URL;
      console.log(login_url);
      const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    let emailTemplate = loadTemplate("forgot_email.html");

    const emailHtml = replaceTemplate(emailTemplate, {
      FULLNAME: user.fullname,
      PASSWORD: newPassword,
      LOGIN_URL: login_url,
      YEAR: new Date().getFullYear()
    });

    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: "Forgot Password Email",
      html: emailHtml
    })
    .then(() => console.log("forgot password email sent"))
    .catch(err => console.error("Email error:", err));

      return res.json({
        status: 'ok',
        message: 'New password sent to email',
      });

    } finally {
      conn.release();
    }

  } catch (err) {
    console.error("Error in /api/forgotpassword:", err);
    return res.status(500).json({
      status: 'error',
      message: 'internal_server_error'
    });
  }
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  try {
    
    const userId = req.body.user_id ? Number(req.body.user_id) : Number(req.user.id);
    const { current_pass, new_pass } = req.body;

    if (!current_pass || !new_pass) {
      return res.status(400).json({ status: 'error', message: 'Missing fields' });
    }

    // NEW: 8-digit minimum, digits only
    if (typeof new_pass !== 'string' || new_pass.length < 8 || !/^\d+$/.test(new_pass)) {
      return res.status(400).json({
        status: 'error',
        message: 'Password must be digits only and at least 8 characters long'
      });
    }

    const conn = await pool.getConnection();

    try {
      console.log("SQL → SELECT password_hash FROM users WHERE id =", userId);

      const [rows] = await conn.query(
        'SELECT password_hash FROM users WHERE id = ? LIMIT 1',
        [userId]
      );

      if (!rows.length) {
        return res.status(404).json({ status: 'error', message: 'User not found' });
      }

      if (rows[0].password_hash !== current_pass) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid current password'
        });
      }

      await conn.query(
        'UPDATE users SET password_hash = ? WHERE id = ?',
        [new_pass, userId]
      );

      return res.json({
        status: 'ok',
        message: 'Password updated successfully'
      });

    } finally {
      conn.release();
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', message: 'Internal Server Error' });
  }
});

app.get('/api/get-dashboard', requireAuth, async (req, res) => {
  const userData = req.user;

  let conn;
  try {
    conn = await pool.getConnection();

    // --- Prepare common transaction query (join user names) ---
    const txnBase = `
      SELECT
        t.id,
        t.tx_uuid,
        t.user_id,
        u.fullname as fromusername,
        t.to_user_id,
        ut.fullname as tousername,
        t.to_address,
        t.from_address,
        t.amount,
        t.txn_type,
        t.token_symbol,
        t.status,
        t.created_at
      FROM transactions t
      LEFT JOIN users u  ON t.user_id = u.id
      LEFT JOIN users ut ON t.to_user_id = ut.id
    `;

    // Non-admin user: fetch user's FXC balance and recent transactions filtered by user
      const uid = userData.id;

      const [balanceRows] = await conn.query(
        `SELECT balance, available_balance FROM balances WHERE user_id = ? AND token_symbol = ? LIMIT 1`,
        [uid, 'FXC']
      );

      const balance = balanceRows.length ? balanceRows[0]['balance'] : 0;


    // --- Branch: admin vs normal user ---
    if (userData.is_admin === 1 || userData.is_admin === '1') {
      
      const [balRows] = await conn.query(
        `SELECT COALESCE(SUM(balance+0), 0) AS total_balance FROM balances WHERE token_symbol = ?`,
        ['FXC']
      );
      const total_balance = balRows[0] ? balRows[0].total_balance : 0;

      const [userCountRows] = await conn.query(
        `SELECT COUNT(*) as total_users FROM users`
      );
      const total_users = userCountRows[0] ? userCountRows[0].total_users : 0;

      // recent transactions (most recent 20)
      const [txns] = await conn.query(`${txnBase} ORDER BY t.created_at DESC LIMIT 20`);

      res.json({
        status: 'ok',
        data: {
          total_balance,
          total_users,
          balance,
          recentTransactions: txns
        }
      });
    } else {
      
      // recent transactions where the user is sender OR receiver (limit 20)
      const [txns] = await conn.query(
        `${txnBase} WHERE t.user_id = ? OR t.to_user_id = ? ORDER BY t.created_at DESC LIMIT 20`,
        [uid, uid]
      );

      res.json({
        status: 'ok',
        data: {
          balance:balance,
          recentTransactions: txns
        }
      });
    }
  } catch (err) {
    console.error('get-dashboard error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  } finally {
    if (conn) try { conn.release(); } catch (e) { /* ignore release errors */ }
  }
});

app.post('/api/create-user', requireAuth,requireAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { email, fullname, phone } = req.body;
    if (!email || !fullname) return res.status(400).json({ error: 'email and fullname required' });

    await conn.beginTransaction();

    // generate random password and hash it
    const plainPassword = generatePassword(12);
    
    const [exists] = await conn.query('SELECT id FROM users WHERE email=? LIMIT 1', [email]);
    if (exists.length){
            return res.json({ status: 'error','message':'Email already exists' });
    } 

    // insert into users
    const [userResult] = await conn.query(
      `INSERT INTO users (email, password_hash, phone, fullname, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [email, plainPassword, phone || null, fullname]
    );

    // get inserted user id
    const userId = userResult.insertId;
    if (!userId) {
      return res.json({ status: 'error','message':'create user failled' });
    }

    // generate wallet
    const wallet = ethers.Wallet.createRandom();
    const address = wallet.address;
    const privateKey = wallet.privateKey; // 0x...
    const mnemonic = wallet.mnemonic?.phrase || null;

    // encrypt private key
    const enc = encryptPrivateKey(privateKey);
    // enc = { ciphertext, iv, tag }

    // insert wallet row
    await conn.query(
      `INSERT INTO wallets (user_id, address, encrypted_private_key, enc_iv, enc_tag, mnemonic, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [userId, address, enc.ciphertext, enc.iv, enc.tag, mnemonic]
    );

    // initialize balances row
    await conn.query(
      `INSERT INTO balances (user_id, token_symbol, balance, available_balance, updated_at)
       VALUES (?, 'FXC', 0, 0, NOW())
       ON DUPLICATE KEY UPDATE updated_at = NOW()`,
      [userId]
    );

    // commit
    await conn.commit();

    console.log(`New user created: id=${userId}, email=${email}`);

    return res.json({ status: 'ok' });
  } catch (err) {
    await conn.rollback();
    console.error('Error in /api/create-user:', err);
    return res.status(500).json({ error: 'internal_server_error' });
  } finally {
    conn.release();
  }
});

/**
 * 1) Generate address (custodial): create a wallet, encrypt private key, save to DB
 * POST body: { user_id, note }
 */
app.post('/api/generate-address', requireAuth,requireAdmin, async (req, res) => {
  try {
    const { user_id, note } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    // create new wallet using ethers
    const wallet = ethers.Wallet.createRandom();
    const address = wallet.address;
    const privateKey = wallet.privateKey;
    const mnemonic = wallet.mnemonic?.phrase || null;

    // encrypt private key
    const enc = encryptPrivateKey(privateKey);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO wallets (user_id, address, encrypted_private_key, enc_iv, enc_tag, mnemonic, created_at)
         VALUES (?,?,?,?,?,?,NOW())`,
        [user_id, address, enc.ciphertext, enc.iv, enc.tag, mnemonic]
      );

      // create or update balances row
      await conn.query(
        `INSERT INTO balances (user_id, token_symbol, balance, available_balance, updated_at)
         VALUES (?, "FXC", 0, 0, NOW())
         ON DUPLICATE KEY UPDATE updated_at=NOW()`,
        [user_id]
      );

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    return res.json({
      status: 'ok',
      address,
      mnemonic,
    });
  } catch (err) {
    console.error('Error in /api/generate-address:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 2) Get balance by user_id or address
 * GET /api/get-balance?user_id=1  or ?address=0x...
 */
app.get('/api/get-balance', requireAuth, async (req, res) => {
  try {
    const { user_id, address } = req.query;
    if (!user_id && !address) return res.status(400).json({ error: 'user_id or address required' });

    if (user_id) {
      const [rows] = await pool.query('SELECT balance, available_balance FROM balances WHERE user_id = ? AND token_symbol = "FXC"', [user_id]);
      const bal = rows[0] || { balance: '0', available_balance: '0' };
      return res.json({ status: 'ok', balance: bal.balance.toString(), available_balance: bal.available_balance.toString() });
    } else {
      // on-chain balance (if live enabled) else search wallets table
      if (process.env.IS_ENABLE_LIVE === 'true' && tokenContract) {
        const b = await tokenContract.balanceOf(address);
        return res.json({ status: 'ok', onchain: formatUnits(b) });
      } else {
        const [rows] = await pool.query('SELECT user_id FROM wallets WHERE address = ?', [address]);
        if (!rows.length) return res.json({ status: 'ok', balance: '0' });
        const uid = rows[0].user_id;
        const [r2] = await pool.query('SELECT balance FROM balances WHERE user_id = ? AND token_symbol="FXC"', [uid]);
        return res.json({ status: 'ok', balance: (r2[0]?.balance || '0').toString(), user_id: uid });
      }
    }
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

/**
 * 3) Admin -> User transfer
 * POST /api/admin-transfer { user_id, amount, idempotency_key }
 */
app.post('/api/admin-transfer', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { user_id, amount, idempotency_key } = req.body;
    if (!user_id || !amount) return res.status(400).json({ error: 'user_id or amount missing' });

    // pick on-chain or db-only via performTransfer helper
    const result = await performTransfer({ fromUserId: null, toUserId: user_id, amountDecimal: amount, adminId: null, idempotencyKey: idempotency_key, preferOnchain: (process.env.IS_ENABLE_LIVE === 'true') });
    res.json({ status: 'ok', result });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

/**
 * 4) User -> User transfer
 * POST /api/user-transfer { from_user, to_user, amount, prefer_onchain (bool), idempotency_key }
 */
app.post('/api/user-transfer', requireAuth, async (req, res) => {
  try {
    const { address, amount } = req.body;

    // 1) Basic validation
    if (!address || !amount) {
      return res.status(400).json({ error: 'address or amount missing' });
      return res.json({ status: 'error', message:'address or amount missing' });
    }

    // 2) Lookup wallet owner (receiver)
    const [rows] = await pool.query(
      'SELECT user_id FROM wallets WHERE address = ? OR user_id = ? LIMIT 1',
      [address, address]
    );

    if (!rows.length) {
      return res.json({ status: 'error', message:'address not found in wallets table' });
    }

    const receiverUserId = rows[0].user_id;

    // 3) Load receiver user info
    const [receiverInfo] = await pool.query(
      'SELECT fullname, email FROM users WHERE id = ? LIMIT 1',
      [receiverUserId]
    );

    if (!receiverInfo.length) {
      return res.json({ status: 'error', message:'receiver user not found' });
    }

    const receiver = receiverInfo[0];

    // 4) Sender info (from session)
    const sender = {
      id: req.user.id,
      fullname: req.user.fullname,
      email: req.user.email
    };

    // 5) Generate idempotency key
    const idempotencyKey = crypto.randomUUID();

    // 6) Perform backend transfer
    const result = await performTransfer({
      fromUserId: sender.id,
      toUserId: receiverUserId,
      amountDecimal: amount,
      idempotencyKey
    });

    // 7) Setup mail transporter
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    const YEAR = new Date().getFullYear();
    const LOGIN_URL = process.env.APP_URL + "login";

    /* =============================
       EMAIL 1: SEND TO SENDER
       Template: sender_email.html
    ============================== */
    const senderTemplate = loadTemplate("sender_email.html");

    const senderHtml = replaceTemplate(senderTemplate, {
      SENDERNAME: sender.fullname,
      RECEIVERNAME: receiver.fullname,
      COIN: amount,          
      LOGIN_URL: LOGIN_URL,
      YEAR: YEAR
    });

    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: sender.email,
      subject: "FXC Transfer Successful",
      html: senderHtml
    })
    .then(() => console.log("✔ Sender email sent to:", sender.email))
    .catch(err => console.error("❌ Sender email error:", err));


    /* =============================
       EMAIL 2: SEND TO RECEIVER
       Template: receiver_email.html
    ============================== */
    const receiverTemplate = loadTemplate("receiver_email.html");

    const receiverHtml = replaceTemplate(receiverTemplate, {
      RECEIVERNAME: receiver.fullname,
      SENDERNAME: sender.fullname,
      COIN: amount,
      LOGIN_URL: LOGIN_URL,
      YEAR: YEAR
    });

    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: receiver.email,
      subject: "You Received FXC",
      html: receiverHtml
    })
    .then(() => console.log("✔ Receiver email sent to:", receiver.email))
    .catch(err => console.error("❌ Receiver email error:", err));


    // 8) Return success
    res.json({ status: 'ok', result });

  } catch (err) {
    console.error("❌ Transfer Error:", err);
    res.status(500).json({ error: err.message });
  }
});


/**
 * 5) Mint / Burn (admin-only)
 * POST /api/mint { to_address OR user_id, amount }
 * POST /api/burn { from_address OR user_id, amount }
 */
app.post('/api/mint', requireAuth, async (req, res) => {
  try {
    const { address, amount } = req.body;

    const [rows] = await pool.query(
      'SELECT user_id FROM wallets WHERE address = ? OR user_id = ? LIMIT 1',
      [address, address]
    );

    if (!rows.length) {
      return res.status(400).send('address not found in wallets table');
    }
    const userId = rows[0].user_id;

    const idempotencyKey = crypto.randomUUID();

    const result = await performMint({
      toAddress: address,
      amountDecimal: amount,
      userId,
      idempotencyKey
    });

    res.json({ status: 'ok', result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/burn', requireAuth, async (req, res) => {
  try {
    const { address, amount } = req.body;

    const [rows] = await pool.query(
      'SELECT user_id FROM wallets WHERE address = ? OR user_id = ? LIMIT 1',
      [address, address]
    );

    if (!rows.length) {
      return res.status(400).send('address not found in wallets table');
    }
    const userId = rows[0].user_id;

    const idempotencyKey = crypto.randomUUID();

    const result = await performBurn({
      fromAddress: address,
      amountDecimal: amount,
      userId,
      idempotencyKey
    });

    res.json({ status: 'ok', result });
  } catch (err) {
    console.error('Error in /api/burn:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', async (req, res) => {
  try {
    const [r] = await pool.query('SELECT 1+1 AS ok');
    res.json({ status: 'ok', db: r[0].ok });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/api/balances/:userId?', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const requester = req.user;

    if (requester.id !== Number(userId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const balances = await getBalances(userId);    
    res.json({ status: 'ok', data:balances[0] });
  } catch (err) {
    console.error('Error in /api/balances:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/mint', requireAuth, async (req, res) => {
  try {
     let conn = await pool.getConnection();
     const txnBase = `
      SELECT
        t.id,
        t.tx_uuid,
        t.user_id,
        u.fullname as fromusername,
        t.to_user_id,
        ut.fullname as tousername,
        t.to_address,
        t.from_address,
        t.amount,
        t.txn_type,
        t.token_symbol,
        t.status,
        t.created_at
      FROM transactions t
      LEFT JOIN users u  ON t.user_id = u.id
      LEFT JOIN users ut ON t.to_user_id = ut.id
      WHERE t.txn_type = 'mint'
    `;

    const [txns] = await conn.query(`${txnBase} ORDER BY t.created_at DESC`);


    res.json({ status: 'ok', data: txns });
  } catch (err) {
    console.error('Error in /api/reports/mint:', err);
    res.status(500).json({ error: err.message });
  }
});


// GET report for all burn transactions
app.get('/api/reports/burn', requireAuth, async (req, res) => {
  try {
      // --- Prepare common transaction query (join user names) ---
    let conn = await pool.getConnection();
    const txnBase = `
      SELECT
        t.id,
        t.tx_uuid,
        t.user_id,
        u.fullname as fromusername,
        t.to_user_id,
        ut.fullname as tousername,
        t.to_address,
        t.from_address,
        t.amount,
        t.txn_type,
        t.token_symbol,
        t.status,
        t.created_at
      FROM transactions t
      LEFT JOIN users u  ON t.user_id = u.id
      LEFT JOIN users ut ON t.to_user_id = ut.id
      WHERE t.txn_type = 'burn'
    `;

    const [txns] = await conn.query(`${txnBase} ORDER BY t.created_at DESC`);


    res.json({ status: 'ok', data: txns });
  } catch (err) {
    console.error('Error in /api/reports/burn:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET report for all burn transactions
app.get('/api/reports/deposit', requireAuth, async (req, res) => {
  try {
      const userData = req.user;

      // --- Prepare common transaction query (join user names) ---
    let conn = await pool.getConnection();
    const txnBase = `
      SELECT t.*,u.fullname FROM deposit t
      LEFT JOIN users u  ON t.user_id = u.id
    `;

    if (userData.is_admin === 1 || userData.is_admin === '1') {
          const [txns] = await conn.query(`${txnBase} ORDER BY t.created_at DESC`);
          res.json({ status: 'ok', data: txns });
    }else{
      // recent transactions where the user is sender OR receiver (limit 20)
          const [txns] = await conn.query(
            `${txnBase} WHERE t.user_id = ?  ORDER BY t.created_at DESC`,
            [userData.id]
          );
          res.json({ status: 'ok', data: txns });

    }


  } catch (err) {
    console.error('Error in /api/reports/burn:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET report for all burn transactions
app.get('/api/reports/userlist', requireAuth, async (req, res) => {
  try {
      const userData = req.user;

      // --- Prepare common transaction query (join user names) ---
    let conn = await pool.getConnection();
    const txnBase = `
      SELECT u.id,u.fullname,u.email,u.phone,u.profile_image,u.created_at,u.is_active,u.kyc_status,w.address FROM users u
      LEFT JOIN wallets w  ON w.user_id = u.id
      WHERE u.is_admin = 0 
    `;

     const [txns] = await conn.query(`${txnBase} ORDER BY u.created_at DESC`);
          res.json({ status: 'ok', data: txns });

  } catch (err) {
    console.error('Error in /api/reports/burn:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET report for all burn transactions
app.get('/api/reports/withdrawal', requireAuth, async (req, res) => {
  try {
    const userData = req.user;
    // --- Prepare common transaction query (join user names) ---
    let conn = await pool.getConnection();
    const txnBase = `
      SELECT t.*,u.fullname FROM withdrawal t
      LEFT JOIN users u  ON t.user_id = u.id
    `;

    if (userData.is_admin === 1 || userData.is_admin === '1') {
          const [txns] = await conn.query(`${txnBase} ORDER BY t.created_at DESC`);
          res.json({ status: 'ok', data: txns });
    }else{
      // recent transactions where the user is sender OR receiver (limit 20)
          const [txns] = await conn.query(
            `${txnBase} WHERE t.user_id = ?  ORDER BY t.created_at DESC`,
            [userData.id]
          );
          res.json({ status: 'ok', data: txns });

    }


  } catch (err) {
    console.error('Error in /api/reports/withdrawal:', err);
    res.status(500).json({ error: err.message });
  }
});



app.get('/api/transactions', requireAuth, async (req, res) => {
  let conn;
  try {
    const user = req.user;
    conn = await pool.getConnection();

     // --- Prepare common transaction query (join user names) ---
    const txnBase = `
      SELECT
        t.id,
        t.tx_uuid,
        t.user_id,
        u.fullname as fromusername,
        t.to_user_id,
        ut.fullname as tousername,
        t.to_address,
        t.from_address,
        t.amount,
        t.txn_type,
        t.token_symbol,
        t.status,
        t.created_at
      FROM transactions t
      LEFT JOIN users u  ON t.user_id = u.id
      LEFT JOIN users ut ON t.to_user_id = ut.id
    `;

  if (user.is_admin === 1 || user.is_admin === '1') {
      const [txns] = await conn.query(`${txnBase} ORDER BY t.created_at DESC`);
        res.json({ status: 'ok', data: txns });
}else{
  // recent transactions where the user is sender OR receiver (limit 20)
      const [txns] = await conn.query(
        `${txnBase} WHERE t.user_id = ? OR t.to_user_id = ? ORDER BY t.created_at DESC`,
        [user.id, user.id]
      );
        res.json({ status: 'ok', data: txns });
}

  } catch (err) {
    console.error('Error in /api/transactions:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 2) Get balance by user_id or address
 * GET /api/get-balance?user_id=1  or ?address=0x...
 */
app.get('/api/get-profile', requireAuth, async (req, res) => {
  try {
    const  userData  = req.user;
    const conn = await pool.getConnection();
    const [rows] = await conn.query('SELECT id, email, fullname, phone, profile_image,is_active, kyc_status,is_admin,aadhar_front,pancard_no,pancard_image,aadhar_back,bank_account.* FROM users left join bank_account on users.id = bank_account.user_id WHERE id = ? LIMIT 1', [userData.id]);
    res.json({ status: 'ok', user: rows[0] });
    
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});


app.post('/api/update-profile',
  requireAuth,
  upload.fields([
    { name: 'profile_image', maxCount: 1 },
    { name: 'aadhar_front', maxCount: 1 },
    { name: 'aadhar_back', maxCount: 1 },
    { name: 'pancard_image', maxCount: 1 }
  ]),
  async (req, res) => {

    const targetUserId = req.user.is_admin && req.body.user_id
                          ? Number(req.body.user_id)
                          : Number(req.user.id);
    
    const conn = await pool.getConnection();

    try {
      // Validate required fields
      const { fullname, email, phone, pancard_no } = req.body;
      const errors = [];

      if (!fullname || fullname.trim() === "") errors.push("fullname is required");
      if (!phone || phone.trim() === "") errors.push("phone is required");

      if (errors.length) {
        console.log("==== VALIDATION ERRORS ====");
        console.log(errors);

        // Cleanup files
        if (req.files) {
          Object.values(req.files).flat().forEach(f => {
            try { fs.unlinkSync(f.path); } catch (e) {}
          });
        }

        return res.status(400).json({ status: "error", errors });
      }

      // Prepare update fields
      const updates = {
        fullname: fullname.trim(),
        phone: phone.trim(),
        pancard_no: pancard_no?.trim() || ""
      };

      const fileMap = {
        profile_image: "profile_image",
        aadhar_front: "aadhar_front",
        aadhar_back: "aadhar_back",
        pancard_image: "pancard_image"
      };

      // Add uploaded file names
      if (req.files) {
        for (const [field, dbCol] of Object.entries(fileMap)) {
          if (req.files[field] && req.files[field].length > 0) {
            updates[dbCol] = req.files[field][0].filename;
          }
        }
      }

      // Build SQL dynamically
      const setParts = [];
      const values = [];

      for (const [k, v] of Object.entries(updates)) {
        setParts.push(`${k} = ?`);
        values.push(v);
      }

      values.push(targetUserId);

      const sql = `UPDATE users SET ${setParts.join(', ')}, updated_at = NOW() WHERE id = ?`;

      await conn.beginTransaction();
      await conn.query(sql, values);
      await conn.commit();

      return res.json({ status: "ok", message: "profile updated" });

    } catch (err) {
      console.error("==== ERROR OCCURRED ====");
      console.error(err);

      if (req.files) {
        Object.values(req.files).flat().forEach(f => {
          try { fs.unlinkSync(f.path); } catch (e) {}
        });
      }

      try { await conn.rollback(); } catch (e) {}

      return res.status(500).json({ status: "error", error: err.message });

    } finally {
      conn.release();
    }
  }
);

  
app.post('/api/update-bankaccount',
  requireAuth,
  upload.fields([
    { name: 'attachment', maxCount: 1 },
  ]),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {            
      const userId = req.user.is_admin && req.body.user_id
                          ? Number(req.body.user_id)
                          : Number(req.user.id);
      const {
        account_holder_name,
        account_no,
        ifsc,
        bank_name,
        branch_name,
        bank_acc_id
      } = req.body;

      console.log
      const errors = [];
      if (!account_holder_name) errors.push("account_holder_name is required");
      if (!account_no) errors.push("account_no is required");
      if (!ifsc) errors.push("ifsc is required");
      if (!bank_name) errors.push("bank_name is required");

      if (errors.length) {
        if (req.files) cleanupUploads(req.files);
        return res.status(400).json({ status: "error", errors });
      }

      // ----------------------------
      // 2. FILE HANDLING
      // ----------------------------
      let attachmentFile = null;
      if (req.files && req.files.attachment && req.files.attachment.length > 0) {
        attachmentFile = req.files.attachment[0].filename;
      }

      await conn.beginTransaction();

      // ----------------------------
      // 3. CHECK IF updating or creating new
      // ----------------------------
      let sql, params;

      if (bank_acc_id) {
    
        let fields = [
            "account_holder_name = ?",
            "account_no = ?",
            "ifsc = ?",
            "bank_name = ?",
            "branch_name = ?"
        ];

        params = [
            account_holder_name,
            account_no,
            ifsc,
            bank_name,
            branch_name
        ];

        if (attachmentFile) {
            fields.push("attachment = ?");
            params.push(attachmentFile);
        }

        sql = `
          UPDATE bank_account
          SET ${fields.join(', ')}
          WHERE bank_acc_id = ? AND user_id = ?
        `;

        params.push(bank_acc_id, userId);

    } else {
        // INSERT
        sql = `
          INSERT INTO bank_account 
          (user_id, account_holder_name, account_no, ifsc, 
           bank_name, branch_name, attachment, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())
        `;

        params = [
          userId,
          account_holder_name,
          account_no,
          ifsc,
          bank_name,
          branch_name,
          attachmentFile
        ];
      }

      await conn.query(sql, params);
      await conn.commit();

      return res.json({
        status: "ok",
        message: bank_acc_id
          ? "Bank account updated successfully"
          : "Bank account added successfully"
      });

    } catch (err) {
      console.error(err);

      if (req.files) cleanupUploads(req.files);

      try {
        await conn.rollback();
      } catch (e) {}

      return res.status(500).json({
        status: "error",
        message: err.message
      });

    } finally {
      conn.release();
    }
  }
);

// fields names: profile_image, aadhar_front, aadhar_back, pancard_image
app.post('/api/save-deposit',
  requireAuth,
  upload.fields([
    { name: 'attachment', maxCount: 1 },
  ]),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      // Use logged in user. If admin wants to update other users, check req.user.is_admin and allow override:
      // const targetUserId = req.user.is_admin && req.body.user_id ? Number(req.body.user_id) : req.user.id;
      const targetUserId = Number(req.user.id);

      // Validate required fields (except files)
      const { amount } = req.body;
      const errors = [];
      if (!amount || String(amount).trim().length === 0) errors.push('amount is required');
      if (errors.length) {
        // remove any uploaded files in this request (cleanup)
        if (req.files) {
          Object.values(req.files).flat().forEach(f => {
            try { fs.unlinkSync(f.path); } catch (e) { /* ignore */ }
          });
        }
        return res.status(400).json({ status: 'error', errors });
      }
      const num = Math.floor(100000000000 + Math.random() * 900000000000);

      // Prepare fields to update
      const updates = {
        amount: String(amount).trim(),
        user_id:targetUserId,
        transaction_id:num,
        status:0
      };

      // handle uploaded files - if uploaded, update field with filename; otherwise keep existing DB value
      // Note: your DB columns earlier were profile_image, aadhar_front, aadhar_back, pancard_image (or pancard_image)
      const fileMap = {
        attachment: 'attachment',
      };

      // Add file names to updates if present
      if (req.files) {
        for (const [field, dbCol] of Object.entries(fileMap)) {
          if (req.files[field] && req.files[field].length > 0) {
            updates[dbCol] = req.files[field][0].filename;
          }
        }
      }

      const columns = [];
      const placeholders = [];
      const values = [];

      for (const [k, v] of Object.entries(updates)) {
        columns.push(k);
        placeholders.push("?");
        values.push(v);
      }

      // If you want created_at & updated_at auto values
      columns.push("created_at");
      placeholders.push("NOW()");  // no ? needed
      // No values.push() because NOW() is raw SQL

      const sql = `
        INSERT INTO deposit (${columns.join(", ")})
        VALUES (${placeholders.join(", ")})
      `;

      await conn.beginTransaction();


      await conn.query(sql, values);

      // If you also want to update wallets table or balances, do it here.

      await conn.commit();

      return res.json({ status: 'ok', message: 'Deposit recored inserted successfully' });
    } catch (err) {
      // on error, remove uploaded files to avoid orphan files
      if (req.files) {
        Object.values(req.files).flat().forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
      }
      console.error('Error in /api/save-deposit:', err);
      try { await conn.rollback(); } catch(e) {}
      return res.status(500).json({ status: 'error', error: err.message });
    } finally {
      conn.release();
    }
  });

app.post('/api/approve-deposit', requireAuth, async (req, res) => {
    const userId = req.user.id;
    const { deposit_id } = req.body;

    if (!deposit_id || deposit_id <= 0) {
        return res.status(400).json({ status: 'error', message: 'Invalid deposit id' });
    }
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            "SELECT * FROM deposit WHERE deposit_id = ?",
            [deposit_id]
        );

        if (!rows.length) {
            return res.status(400).json({
                status: 'error',
                message: 'deposit record not found'
            });
        }

        const deposit = rows[0];

        const amount = Number(deposit.amount);
        const toUser = Number(deposit.user_id);

        const idempotencyKey = crypto.randomUUID();

        const result = await performTransfer({
          fromUserId: Number(process.env.ADMIN_ID),
          toUserId: toUser,
          amountDecimal: amount,
          idempotencyKey,
          
        });

        if (result && result.status === 'ok') {
           await conn.query(
            "UPDATE deposit SET status = 1 WHERE deposit_id = ?",
            [deposit_id]
          );
        }
         await conn.commit();
        return res.json({status: 'ok',result});
    }catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
});


app.post('/api/approve-withdrawal', requireAuth, async (req, res) => {
    const userId = req.user.id;
    const { withdrawal_id } = req.body;
    
    if (!withdrawal_id || withdrawal_id <= 0) {
        return res.status(400).json({ status: 'error', message: 'Invalid withdrawal id' });
    }

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        // Check record exists
        const [rows] = await conn.query(
            "SELECT * FROM withdrawal WHERE withdrawal_id = ?",
            [withdrawal_id]
        );

        if (!rows || rows.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'Withdrawal record not found'
            });
        }

        // Update status + approved date
        await conn.query(
            "UPDATE withdrawal SET status = 1, approved_at = NOW() WHERE withdrawal_id = ?",
            [withdrawal_id]
        );

        // Fetch updated date
        const [updatedRow] = await conn.query(
            "SELECT approved_at FROM withdrawal WHERE withdrawal_id = ?",
            [withdrawal_id]
        );

        const approvedAtFormatted = formatDateToDMY(updatedRow[0].approved_at);
        await conn.commit();

        return res.json({
            status: 'ok',
            message: "Updated withdrawal record",
             approved_at: approvedAtFormatted
        });

    } catch (err) {
        await conn.rollback();
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});


app.post('/api/save-withdrawal', requireAuth, async (req, res) => {
    const userId = req.user.id;
    const { amount } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).json({ status: 'error', message: 'Invalid amount' });
    }

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        // 1. Get user balance
        const [bal] = await conn.query(
            "SELECT balance FROM balances WHERE user_id = ? AND token_symbol = 'FXC' LIMIT 1",
            [userId]
        );

        if (!bal.length) {
            return res.status(400).json({
                status: 'error',
                message: 'Wallet not found'
            });
        }

        const balance = parseFloat(bal[0].balance);

        if (amount > balance) {
            return res.status(400).json({
                status: 'error',
                message: "You cannot withdraw more than your available balance"
            });
        }

        let request_id = Math.floor(100000 + Math.random() * 900000);


        await conn.query(
            `INSERT INTO withdrawal 
                (user_id, request_id, amount, status, created_at) 
             VALUES 
                (?, ?, ?, 0, NOW())`,
            [userId, request_id, amount]
        );

        await conn.commit();
        const idempotencyKey = crypto.randomUUID();

        const result = await performTransfer({
          fromUserId: req.user.id,
          toUserId: process.env.ADMIN_ID,
          amountDecimal: amount,
          idempotencyKey,
          
        });

        return res.json({status: 'ok',result});
    }catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
});

app.post('/api/change-user-status', requireAuth, requireAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.body;    
    if (!id) return res.status(400).json({ status: 'error', message: 'User ID is required' });

    // Check if user exists
    const [users] = await conn.query('SELECT id, is_active FROM users WHERE id=? LIMIT 1', [id]);
    if (!users.length) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    const user = users[0];
    const newStatus = user.is_active === 1 ? 0 : 1; // Toggle status    
    // Update status
    await conn.query('UPDATE users SET is_active=? WHERE id=?', [newStatus, id]);

    return res.json({ status: 'ok', newStatus });
  } catch (err) {
    console.error('Error in /api/change-user-status:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  } finally {
    conn.release();
  }
});

app.get('/api/user/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.params.id;

    // Only admin can fetch other users
    

    const conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT u.id, u.email, u.fullname, u.phone, u.profile_image, u.is_active, u.kyc_status, u.is_admin,
            u.aadhar_front, u.pancard_no, u.pancard_image, u.aadhar_back,
            b.*
      FROM users u
      LEFT JOIN bank_account b ON u.id = b.user_id
      WHERE u.id = ?
      LIMIT 1
    `, [userId]);

    conn.release();

    if (!rows[0]) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    res.json({ status: 'ok', data: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/export-excel', requireAuth, async (req, res) => {
    const user = req.user;
    const fromDate = req.query.from;
    const toDate = req.query.to;

    let conn;
    try {
        conn = await pool.getConnection();

        let txnQuery = `
          SELECT
            t.id,
            t.tx_uuid,
            t.user_id,
            u.fullname as fromusername,
            t.to_user_id,
            ut.fullname as tousername,
            t.to_address,
            t.from_address,
            t.amount,
            t.txn_type,
            t.token_symbol,
            t.status,
            t.created_at
          FROM transactions t
          LEFT JOIN users u ON t.user_id = u.id
          LEFT JOIN users ut ON t.to_user_id = ut.id
          WHERE t.created_at BETWEEN ? AND ?
        `;

        const fromDateTime = `${fromDate} 00:00:00`;
        const toDateTime = `${toDate} 23:59:59`;
        let params = [fromDateTime, toDateTime];

        if (!(user.is_admin === 1 || user.is_admin === '1')) {
            txnQuery += ' AND (t.user_id = ? OR t.to_user_id = ?)';
            params.push(user.id, user.id);
        }

        txnQuery += ' ORDER BY t.created_at DESC';

        const [transactions] = await conn.query(txnQuery, params);

        // --- ExcelJS code ---
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Transactions');

        sheet.columns = [
            { header: 'ID', key: 'id', width: 10 },
            { header: 'TX UUID', key: 'tx_uuid', width: 30 },
            { header: 'From User', key: 'fromusername', width: 25 },
            { header: 'To User', key: 'tousername', width: 25 },
            { header: 'From Address', key: 'from_address', width: 30 },
            { header: 'To Address', key: 'to_address', width: 30 },
            { header: 'Amount', key: 'amount', width: 15 },
            { header: 'Type', key: 'txn_type', width: 15 },
            { header: 'Token', key: 'token_symbol', width: 10 },
            { header: 'Status', key: 'status', width: 15 },
            { header: 'Created At', key: 'created_at', width: 20 },
        ];

        transactions.forEach(txn => sheet.addRow(txn));

        // Save file
        const exportDir = path.join(__dirname, 'public', 'exports');
        if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

        const filename = `transactions_${Date.now()}.xlsx`;
        const filepath = path.join(exportDir, filename);
        await workbook.xlsx.writeFile(filepath);

        const fileUrl = `/exports/${filename}`;
        res.json({ success: true, file_url: fileUrl });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (conn) conn.release();
    }
});

app.post('/api/kyc-verify', requireAuth, requireAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({ status: 'error', message: 'User ID is required' });
    }

    // Check if user exists
    const [users] = await conn.query('SELECT id, kyc_status FROM users WHERE id=? LIMIT 1', [id]);
    
    if (!users.length) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    const user = users[0];

    if (user.kyc_status === 'verified') {
      return res.json({ status: 'ok', message: 'User already verified' });
    }

    // Update KYC Status to Verified
    await conn.query('UPDATE users SET kyc_status=? WHERE id=?', ['verified', id]);

    return res.json({ status: 'ok', message: 'KYC verified successfully' });

  } catch (err) {
    console.error('Error in /api/kyc-verify:', err);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  } finally {
    conn.release();
  }
});


app.post('/api/mobile-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(email);
    if (!email || !password) return res.json({ status: 'error', message: 'email and password required' });

    // fetch user by email
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT users.id, email, password_hash,profile_image, fullname, phone, is_active, kyc_status,is_admin,wallets.address FROM users left join wallets on users.id = wallets.user_id WHERE email = ? LIMIT 1', [email]);
      if (!rows.length) return res.status(401).json({ status: 'error', message: 'invalid credentials' });

      const user = rows[0];

      if (!user.is_active) return res.json({ status: 'error', message: 'account disabled' });

      let passwordMatches = user.password_hash;     

      if (passwordMatches !== password) {
        return res.json({ status: 'error', message: 'invalid credentials' });
      }
     

      let otp = Math.floor(1000 + Math.random() * 9000);
      console.log("OTP :",otp);
      // create JWT
      const tokenPayload = {
        sub: user.id,
        email: user.email,
        fullname: user.fullname,
        kyc_status: user.kyc_status,
        is_admin: user.is_admin,
        address:user.address,
        profile_image:user.profile_image
      };
      const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    let emailTemplate = loadTemplate("otp_email.html");

    let html = replaceTemplate(emailTemplate, {
      FULLNAME: user.fullname,
      OTP: otp,
      YEAR: new Date().getFullYear(),
    });  

    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: user.email,
      subject: "Login OTP",
      html: html
    })
    .then(() => console.log("Verification email sent"))
    .catch(err => console.error("Email error:", err));


      // respond with minimal user info + token
      return res.json({
        status: 'ok',
        token,
        otp:otp,
        user: {
          id: user.id,
          email: user.email,
          fullname: user.fullname,
          phone: user.phone,
          kyc_status: user.kyc_status,
          is_admin: user.is_admin,
          xxxx:user.address,
          profile_image:user.profile_image
        }
      });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('Error in /api/login:', err);
    return res.json({ status: 'error', message: 'internal_server_error' });
  }
});

// GET report for all burn transactions
app.get('/api/resend-otp', requireAuth, async (req, res) => {
  try {
    const userData = req.user;
    
    if (userData.email === '') {
        return res.json({ status: 'error', message: 'invalid Access' });
    }
    let otp = Math.floor(1000 + Math.random() * 9000);
    console.log("OTP :",otp);

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    let emailTemplate = loadTemplate("otp_email.html");

    let html = replaceTemplate(emailTemplate, {
      FULLNAME: userData.fullname,
      OTP: otp,
      YEAR: new Date().getFullYear(),
    });  

    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: userData.email,
      subject: "Login OTP",
      html: html
    })
    .then(() => console.log("otp email sent"))
    .catch(err => console.error("Email error:", err));

   // respond with minimal user info + token
      return res.json({
        status: 'ok',
        otp:otp,
      });

  } catch (err) {
    console.error('Error in /api/resend-otp:', err);
    res.status(500).json({ error: err.message });
  }
});



app.get('/api/mint-report', requireAuth, async (req, res) => {
   try {
    const conn = await pool.getConnection();

    // read pagination & search params
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const per_page = Math.max(parseInt(req.query.per_page || '20', 10), 1);
    const offset = (page - 1) * per_page;
    console.log(q);

    // base WHERE clause and params array
    let whereSql = `WHERE t.txn_type = ?`;
    const params = ['mint'];

    // add search if provided
    if (q.length > 0) {
      // search fullname, client_id (users table), token address (to_address)
      whereSql += ` AND (u.fullname LIKE ? OR u.id LIKE ? OR t.to_address LIKE ?)`;
      const likeQ = `%${q}%`;
      params.push(likeQ, likeQ, likeQ);
    }

    // Count total rows matching the filters
    const countSql = `
      SELECT COUNT(*) AS total
      FROM transactions t
      LEFT JOIN users u ON t.user_id = u.id
      LEFT JOIN users ut ON t.to_user_id = ut.id
      ${whereSql}
    `;
    const [countRows] = await conn.query(countSql, params);
    const total = (countRows && countRows[0] && countRows[0].total) ? parseInt(countRows[0].total, 10) : 0;

    // Select data with pagination
    const dataSql = `
      SELECT
        t.id,
        t.tx_uuid,
        t.user_id,
        u.fullname AS fromusername,
        t.to_user_id,
        ut.fullname AS tousername,
        t.to_address,
        t.from_address,
        t.amount,
        t.txn_type,
        t.token_symbol,
        t.status,
        t.created_at
      FROM transactions t
      LEFT JOIN users u  ON t.user_id = u.id
      LEFT JOIN users ut ON t.to_user_id = ut.id
      ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `;

    // append limit/offset params (note: create a new params array to avoid modifying count params)
    const dataParams = params.slice(); // copy
    dataParams.push(per_page, offset);

    const [txns] = await conn.query(dataSql, dataParams);

    const hasMore = page * per_page < total;

    res.json({
      status: 'ok',
      page,
      per_page,
      total,
      has_more: hasMore,
      data: txns
    });

    conn.release();
  } catch (err) {
    console.error("Mint report error:", err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


app.get('/api/burn-report', requireAuth, async (req, res) => {
   try {
    const conn = await pool.getConnection();

    // read pagination & search params
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const per_page = Math.max(parseInt(req.query.per_page || '20', 10), 1);
    const offset = (page - 1) * per_page;
    console.log(q);

    // base WHERE clause and params array
    let whereSql = `WHERE t.txn_type = ?`;
    const params = ['burn'];

    // add search if provided
    if (q.length > 0) {
      // search fullname, client_id (users table), token address (to_address)
      whereSql += ` AND (u.fullname LIKE ? OR u.id LIKE ? OR t.from_address LIKE ?)`;
      const likeQ = `%${q}%`;
      params.push(likeQ, likeQ, likeQ);
    }

    // Count total rows matching the filters
    const countSql = `
      SELECT COUNT(*) AS total
      FROM transactions t
      LEFT JOIN users u ON t.user_id = u.id
      LEFT JOIN users ut ON t.to_user_id = ut.id
      ${whereSql}
    `;
    const [countRows] = await conn.query(countSql, params);
    const total = (countRows && countRows[0] && countRows[0].total) ? parseInt(countRows[0].total, 10) : 0;

    // Select data with pagination
    const dataSql = `
      SELECT
        t.id,
        t.tx_uuid,
        t.user_id,
        u.fullname AS fromusername,
        t.to_user_id,
        ut.fullname AS tousername,
        t.to_address,
        t.from_address,
        t.amount,
        t.txn_type,
        t.token_symbol,
        t.status,
        t.created_at
      FROM transactions t
      LEFT JOIN users u  ON t.user_id = u.id
      LEFT JOIN users ut ON t.to_user_id = ut.id
      ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `;

    // append limit/offset params (note: create a new params array to avoid modifying count params)
    const dataParams = params.slice(); // copy
    dataParams.push(per_page, offset);

    const [txns] = await conn.query(dataSql, dataParams);

    const hasMore = page * per_page < total;

    res.json({
      status: 'ok',
      page,
      per_page,
      total,
      has_more: hasMore,
      data: txns
    });

    conn.release();
  } catch (err) {
    console.error("Mint report error:", err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


app.get('/api/transaction-report', requireAuth, async (req, res) => {
  try {
    const conn = await pool.getConnection();

    // current logged-in user from middleware
    const user = req.user; // or req.userData depending on your auth

    // read pagination & search params
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const per_page = Math.max(parseInt(req.query.per_page || '20', 10), 1);
    const offset = (page - 1) * per_page;

    // build WHERE pieces
    const whereParts = [];
    const params = [];

    // 1) Restrict non-admin users to their own transactions only
    // treat is_admin = 1 or '1' as admin, everything else = non-admin
    const isAdmin = (user && (user.is_admin === 1 || user.is_admin === '1'));

    if (!isAdmin) {
      whereParts.push('(t.user_id = ? OR t.to_user_id = ?)');
      params.push(user.id, user.id);
    }

    // 2) Add search if provided (fullname, client_id (u.id), from_address)
    if (q.length > 0) {
      whereParts.push('(u.fullname LIKE ? OR ut.fullname LIKE ? OR u.id LIKE ? OR t.to_user_id LIKE ? OR  t.to_address LIKE ? OR t.from_address LIKE ?)');
      const likeQ = `%${q}%`;
      params.push(likeQ, likeQ, likeQ,likeQ,likeQ,likeQ);
    }

    // join all WHERE parts
    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    // -------- Count total rows --------
    const countSql = `
      SELECT COUNT(*) AS total
      FROM transactions t
      LEFT JOIN users u  ON t.user_id = u.id
      LEFT JOIN users ut ON t.to_user_id = ut.id
      ${whereSql}
    `;

    const [countRows] = await conn.query(countSql, params);
    const total =
      countRows && countRows[0] && countRows[0].total
        ? parseInt(countRows[0].total, 10)
        : 0;

    // -------- Select data with pagination --------
    const dataSql = `
      SELECT
        t.id,
        t.tx_uuid,
        t.user_id,
        u.fullname AS fromusername,
        t.to_user_id,
        ut.fullname AS tousername,
        t.to_address,
        t.from_address,
        t.amount,
        t.txn_type,
        t.token_symbol,
        t.status,
        t.created_at
      FROM transactions t
      LEFT JOIN users u  ON t.user_id = u.id
      LEFT JOIN users ut ON t.to_user_id = ut.id
      ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `;

    // data params = same filters + limit/offset
    const dataParams = params.slice();
    dataParams.push(per_page, offset);

    const [txns] = await conn.query(dataSql, dataParams);

    const hasMore = page * per_page < total;

    res.json({
      status: 'ok',
      page,
      per_page,
      total,
      has_more: hasMore,
      data: txns
    });

    conn.release();
  } catch (err) {
    console.error("Transaction report error:", err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/admin-userlist', requireAuth, async (req, res) => {
   try {
    const conn = await pool.getConnection();

    // read pagination & search params
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const per_page = Math.max(parseInt(req.query.per_page || '20', 10), 1);
    const offset = (page - 1) * per_page;
    console.log(q);

    // base WHERE clause and params array
    let whereSql = ``;
    
    const params = [];

    // add search if provided
    if (q.length > 0) {
      // search fullname, client_id (users table), token address (to_address)
      whereSql += ` WHERE (u.fullname LIKE ? OR u.id LIKE ? OR w.address LIKE ?)`;
      const likeQ = `%${q}%`;
      params.push(likeQ, likeQ, likeQ);
    }

    // Count total rows matching the filters
    const countSql = `
      SELECT COUNT(*) AS total
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      ${whereSql}
    `;
    const [countRows] = await conn.query(countSql, params);
    const total = (countRows && countRows[0] && countRows[0].total) ? parseInt(countRows[0].total, 10) : 0;

    // Select data with pagination
    const dataSql = `
      SELECT
        u.*,
        w.address
      FROM users u
      LEFT JOIN wallets w  ON w.user_id = u.id
      ${whereSql}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `;

    // append limit/offset params (note: create a new params array to avoid modifying count params)
    const dataParams = params.slice(); // copy
    dataParams.push(per_page, offset);

    const [txns] = await conn.query(dataSql, dataParams);

    const hasMore = page * per_page < total;

    res.json({
      status: 'ok',
      page,
      per_page,
      total,
      has_more: hasMore,
      data: txns
    });

    conn.release();
  } catch (err) {
    console.error("admin user report error:", err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/depositlist', requireAuth, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    const user = req.user;

    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const per_page = Math.max(parseInt(req.query.per_page || '20', 10), 1);
    const offset = (page - 1) * per_page;

    /** -----------------------------
     *   WHERE clause builder
     * ------------------------------*/
    let whereParts = [];
    let params = [];

    // 🔹 NON-ADMIN: restrict results
    if (user.is_admin !== 1 && user.is_admin !== "1") {
      whereParts.push("d.user_id = ?");
      params.push(user.id);
    }

    // 🔹 Search filter (fullname, client_id, wallet address)
    if (q.length > 0) {
      whereParts.push("(u.fullname LIKE ? OR u.id LIKE ? OR w.address LIKE ?)");
      const likeQ = `%${q}%`;
      params.push(likeQ, likeQ, likeQ);
    }

    // Join WHERE parts
    let whereSql = "";
    if (whereParts.length > 0) {
      whereSql = " WHERE " + whereParts.join(" AND ");
    }

    /** -----------------------------
     *   COUNT QUERY
     * ------------------------------*/
    const countSql = `
      SELECT COUNT(*) AS total
      FROM deposit d
      LEFT JOIN users u ON d.user_id = u.id
      LEFT JOIN wallets w ON w.user_id = u.id
      ${whereSql}
    `;
    const [countRows] = await conn.query(countSql, params);
    const total = countRows?.[0]?.total || 0;

    /** -----------------------------
     *   DATA QUERY (PAGINATED)
     * ------------------------------*/
    const dataSql = `
      SELECT 
        d.*,
        u.fullname,
        w.address
      FROM deposit d
      LEFT JOIN users u ON d.user_id = u.id
      LEFT JOIN wallets w ON w.user_id = u.id
      ${whereSql}
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const dataParams = [...params, per_page, offset];
    const [rows] = await conn.query(dataSql, dataParams);

    const hasMore = page * per_page < total;

    res.json({
      status: "ok",
      page,
      per_page,
      total,
      has_more: hasMore,
      data: rows
    });

    conn.release();

  } catch (err) {
    console.error("deposit report error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get('/api/withdrawallist', requireAuth, async (req, res) => {
   try {
    const conn = await pool.getConnection();
    const user = req.user; // or req.userData depending on your auth

    // read pagination & search params
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const per_page = Math.max(parseInt(req.query.per_page || '20', 10), 1);
    const offset = (page - 1) * per_page;
    console.log(q);

   /** -----------------------------
     *   WHERE clause builder
     * ------------------------------*/
    let whereParts = [];
    let params = [];

    // 🔹 NON-ADMIN: restrict results
    if (user.is_admin !== 1 && user.is_admin !== "1") {
      whereParts.push("d.user_id = ?");
      params.push(user.id);
    }

    // 🔹 Search filter (fullname, client_id, wallet address)
    if (q.length > 0) {
      whereParts.push("(u.fullname LIKE ? OR u.id LIKE ? OR w.address LIKE ?)");
      const likeQ = `%${q}%`;
      params.push(likeQ, likeQ, likeQ);
    }

    // Join WHERE parts
    let whereSql = "";
    if (whereParts.length > 0) {
      whereSql = " WHERE " + whereParts.join(" AND ");
    }

    // Count total rows matching the filters
    const countSql = `
      SELECT COUNT(*) AS total
      FROM withdrawal d
      LEFT JOIN users u ON d.user_id = u.id
      LEFT JOIN wallets w ON w.user_id = u.id
      ${whereSql}
    `;
    const [countRows] = await conn.query(countSql, params);
    const total = (countRows && countRows[0] && countRows[0].total) ? parseInt(countRows[0].total, 10) : 0;

    // Select data with pagination
    const dataSql = `
      SELECT
        d.*,
        w.address,
        u.fullname
      FROM withdrawal d
      LEFT JOIN users u ON d.user_id = u.id
      LEFT JOIN wallets w  ON w.user_id = u.id
      ${whereSql}
      ORDER BY d.created_at DESC
      LIMIT ? OFFSET ?
    `;

    // append limit/offset params (note: create a new params array to avoid modifying count params)
    const dataParams = params.slice(); // copy
    dataParams.push(per_page, offset);

    const [txns] = await conn.query(dataSql, dataParams);

    const hasMore = page * per_page < total;

    res.json({
      status: 'ok',
      page,
      per_page,
      total,
      has_more: hasMore,
      data: txns
    });

    conn.release();
  } catch (err) {
    console.error("withdrawal report error:", err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/mobile-dashboard', requireAuth, async (req, res) => {
  const userData = req.user;

  let conn;
  try {
    conn = await pool.getConnection();


    // Non-admin user: fetch user's FXC balance and recent transactions filtered by user
      const uid = userData.id;

      const [balanceRows] = await conn.query(
        `SELECT balance, available_balance FROM balances WHERE user_id = ? AND token_symbol = ? LIMIT 1`,
        [uid, 'FXC']
      );

      const balance = balanceRows.length ? balanceRows[0]['balance'] : 0;


    // --- Branch: admin vs normal user ---
    if (userData.is_admin === 1 || userData.is_admin === '1') {
      // Admin: total balance, total users, recent transactions (no where clause)
      // total_balance: sum of balances for token 'FXC' (force numeric with +0)
      const [balRows] = await conn.query(
        `SELECT COALESCE(SUM(balance+0), 0) AS total_balance FROM balances WHERE token_symbol = ?`,
        ['FXC']
      );
      const total_balance = balRows[0] ? balRows[0].total_balance : 0;

      const [userCountRows] = await conn.query(
        `SELECT COUNT(*) as total_users FROM users`
      );
      const total_users = userCountRows[0] ? userCountRows[0].total_users : 0;

      // recent transactions (most recent 20)

      res.json({
        status: 'ok',
        data: {
          total_balance,
          total_users,
          balance,
        }
      });
    } else {      
     
      res.json({
        status: 'ok',
        data: {
          balance:balance,
        }
      });
    }
  } catch (err) {
    console.error('get-dashboard error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  } finally {
    if (conn) try { conn.release(); } catch (e) { /* ignore release errors */ }
  }
});

app.post('/api/mobile-register', async (req, res) => {
  try {
    const { fullname, email, password } = req.body;

    // Basic validation
    if (!fullname || !email || !password) {
      return res.status(400).json({
        status: 'error',
        message: 'fullname, email and password required'
      });
    }

    const conn = await pool.getConnection();
    try {
      // check email already exists
      const [exists] = await conn.query(
        'SELECT id FROM users WHERE email = ? LIMIT 1',
        [email]
      );

      if (exists.length) {
        return res.json({
          status: 'error',
          message: 'Email already registered'
        });
      }


      // Store user (plain password for your example — you should hash it)
      const [result] = await conn.query(
        `INSERT INTO users (fullname, email, password_hash, is_active, kyc_status, is_admin) 
         VALUES (?, ?, ?, 0, 'pending', 0)`,
        [fullname, email, password]  // password_hash should be hashed in real apps
      );

    const newUserId = result.insertId;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    let otp = Math.floor(1000 + Math.random() * 9000);
    console.log(otp);
    let emailTemplate = loadTemplate("otp_email.html");

    let html = replaceTemplate(emailTemplate, {
      FULLNAME: fullname,
      OTP: otp,
      YEAR: new Date().getFullYear(),
    });  

    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: "Verify Email",
      html: html
    })
    .then(() => console.log("Verification email sent"))
    .catch(err => console.error("Email error:", err));

     
      return res.json({
        status: 'ok',
        otp:otp,
        message: 'Registration successful. Please verify your email.',
        user_id: newUserId
      });

    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('Error in /api/register:', err);
    return res.status(500).json({
      status: 'error',
      message: 'internal_server_error'
    });
  }
});

app.post('/api/mobile-register-resendotp', async (req, res) => {
  try {
    const { email,fullname } = req.body;

    console.log(email);

    const conn = await pool.getConnection();
    try {
      // check email already exists
   

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    let otp = Math.floor(1000 + Math.random() * 9000);
    console.log(otp);
    let emailTemplate = loadTemplate("otp_email.html");

    let html = replaceTemplate(emailTemplate, {
      FULLNAME: fullname,
      OTP: otp,
      YEAR: new Date().getFullYear(),
    });  

    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: "Verify Email",
      html: html
    })
    .then(() => console.log("otp resent"))
    .catch(err => console.error("Email error:", err));

     
      return res.json({
        status: 'ok',
        otp:otp,
        message: 'We have resent OTP successfully.'
      });

    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('Error in /api/mobile-register-resendotp:', err);
    return res.status(500).json({
      status: 'error',
      message: 'internal_server_error'
    });
  }
});
app.post('/api/mobile-user-verification', async (req, res) => {
  const { email } = req.body;

  console.log("murugan : ",email);

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [email]
    );
   if (!rows.length) {
      return res.json({
        status: 'error',
        message: 'Invalid or expired code'
      });
    }

    const userId = rows[0].id;

    await conn.query(
      "UPDATE users SET is_active = 1 WHERE id = ?",
      [userId]
    );

    // generate wallet
    const wallet = ethers.Wallet.createRandom();
    const address = wallet.address;
    const privateKey = wallet.privateKey; // 0x...
    const mnemonic = wallet.mnemonic?.phrase || null;

    // encrypt private key
    const enc = encryptPrivateKey(privateKey);
    // enc = { ciphertext, iv, tag }

    // insert wallet row
    await conn.query(
      `INSERT INTO wallets (user_id, address, encrypted_private_key, enc_iv, enc_tag, mnemonic, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [userId, address, enc.ciphertext, enc.iv, enc.tag, mnemonic]
    );

    // initialize balances row
    await conn.query(
      `INSERT INTO balances (user_id, token_symbol, balance, available_balance, updated_at)
       VALUES (?, 'FXC', 0, 0, NOW())
       ON DUPLICATE KEY UPDATE updated_at = NOW()`,
      [userId]
    );


    return res.json({
        status: 'ok',
        message: 'Your email has been verified successfully.'
      });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', message: 'internal_server_error' });
  } finally {
    conn.release();
  }
});


/**
 * 4) User -> User transfer
 * POST /api/user-transfer { from_user, to_user, amount, prefer_onchain (bool), idempotency_key }
 */
app.post('/api/isAddressExist', async (req, res) => {
  try {
    const { address } = req.body;
    console.log(address);
    // 1) Basic validation
    if (!address) {
      return res.json({ status: 'error', message:'address missing' });
    }

    // 2) Lookup wallet owner (receiver)
    const [rows] = await pool.query(
      'SELECT user_id FROM wallets WHERE address = ?  LIMIT 1',
      [address]
    );

    if (!rows.length) {
      return res.json({ status: 'error', message:'address not found in wallets table' });
    }

     
    const user_id = rows[0].user_id;
    const [userRow] = await pool.query(
      'SELECT fullname,email FROM users WHERE id  = ?  LIMIT 1',
      [user_id]
    );
    const verifyToken = crypto.randomBytes(32).toString("hex");
    const verifyUrl = "https://fxbaylive.com/accounts/finxcore.php?finxcore_code="+verifyToken;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    const fullname = userRow[0].fullname;
    const email = userRow[0].email;

    let emailTemplate = loadTemplate("approval_email.html");

    let html = replaceTemplate(emailTemplate, {
      FULLNAME: fullname,
      VERIFY_URL: verifyUrl,
      YEAR: new Date().getFullYear(),
    });  

    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: "Approval Email",
      html: html
    })
    .then(() => console.log("Approval email sent"))
    .catch(err => console.error("Email error:", err));

    // 8) Return success
    res.json({ status: 'ok', message:"We have sent approval email to your address registered email address, Please follow the link to approve." });

  } catch (err) {
    console.error("❌ Transfer Error:", err);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/getTradebalance', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) return res.json({ status:"error",message:"Finxcore wallet address missing"});

     const [walletRow] = await pool.query(
      'SELECT user_id FROM wallets WHERE address = ?  LIMIT 1',
      [address]
    );
    const user_id = walletRow[0].user_id;
    if (user_id) {
      const [rows] = await pool.query('SELECT balance, available_balance FROM balances WHERE user_id = ? AND token_symbol = "FXC"', [user_id]);
      const bal = rows[0] || { balance: '0', available_balance: '0' };
      return res.json({ status: 'ok', balance: bal.balance.toString(), available_balance: bal.available_balance.toString() });
    } else {
      // on-chain balance (if live enabled) else search wallets table
      if (process.env.IS_ENABLE_LIVE === 'true' && tokenContract) {
        const b = await tokenContract.balanceOf(address);
        return res.json({ status: 'ok', onchain: formatUnits(b) });
      } else {
        const [rows] = await pool.query('SELECT user_id FROM wallets WHERE address = ?', [address]);
        if (!rows.length) return res.json({ status: 'ok', balance: '0' });
        const uid = rows[0].user_id;
        const [r2] = await pool.query('SELECT balance FROM balances WHERE user_id = ? AND token_symbol="FXC"', [uid]);
        return res.json({ status: 'ok', balance: (r2[0]?.balance || '0').toString(), user_id: uid });
      }
    }
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/tradeTransfer', async (req, res) => {
  try {
    const { address, amount,type } = req.body;

    // 1) Basic validation
    if (!address || !amount) {
      return res.status(400).json({ error: 'address or amount missing' });
      return res.json({ status: 'error', message:'address or amount missing' });
    }

    // 2) Lookup wallet owner (receiver)
    const [rows] = await pool.query(
      'SELECT user_id FROM wallets WHERE address = ? OR user_id = ? LIMIT 1',
      [address, address]
    );

    if (!rows.length) {
      return res.json({ status: 'error', message:'address not found in wallets table' });
    }
    const user_id = rows[0].user_id;

     const [userRow] = await pool.query(
      'SELECT fullname,email FROM users WHERE id  = ?  LIMIT 1',
      [user_id]
    );
    let senderId = user_id;
    let senderName = userRow[0].fullname;
    let senderEmail = userRow[0].email;
    

     const [adminRow] = await pool.query('SELECT id,fullname,email FROM users WHERE id  = ? LIMIT 1',[process.env.ADMIN_ID]);

    let receiverId = adminRow[0].id;
    let receiverName = adminRow[0].fullname;
    let receiverEmail = adminRow[0].email;
    
    if(type === "2"){
      senderId = adminRow[0].id;
      senderName = adminRow[0].fullname;
      senderEmail = adminRow[0].email;
      receiverId = user_id;
      receiverName = userRow[0].fullname;
      receiverEmail = userRow[0].email;
    }

    console.log(receiverId);
    // 4) Sender info (from session)
    const sender = {
      id: senderId,
      fullname: senderName,
      email: senderEmail
    };

    // 5) Generate idempotency key
    const idempotencyKey = crypto.randomUUID();

    // 6) Perform backend transfer
    const result = await performTransfer({
      fromUserId: sender.id,
      toUserId: receiverId,
      amountDecimal: amount,
      idempotencyKey
    });

    // 7) Setup mail transporter
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    const YEAR = new Date().getFullYear();
    const LOGIN_URL = process.env.APP_URL + "login";

    /* =============================
       EMAIL 1: SEND TO SENDER
       Template: sender_email.html
    ============================== */
    const senderTemplate = loadTemplate("sender_email.html");

    const senderHtml = replaceTemplate(senderTemplate, {
      SENDERNAME: sender.fullname,
      RECEIVERNAME: receiverName,
      COIN: amount,          
      LOGIN_URL: LOGIN_URL,
      YEAR: YEAR
    });

    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: sender.email,
      subject: "FXC Transfer Successful",
      html: senderHtml
    })
    .then(() => console.log("✔ Sender email sent to:", sender.email))
    .catch(err => console.error("❌ Sender email error:", err));


    /* =============================
       EMAIL 2: SEND TO RECEIVER
       Template: receiver_email.html
    ============================== */
    const receiverTemplate = loadTemplate("receiver_email.html");

    const receiverHtml = replaceTemplate(receiverTemplate, {
      RECEIVERNAME: receiverName,
      SENDERNAME: sender.fullname,
      COIN: amount,
      LOGIN_URL: LOGIN_URL,
      YEAR: YEAR
    });

    transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: receiverEmail,
      subject: "You Received FXC",
      html: receiverHtml
    })
    .then(() => console.log("✔ Receiver email sent to:", receiverEmail))
    .catch(err => console.error("❌ Receiver email error:", err));


    // 8) Return success
    res.json({ status: 'ok', result });

  } catch (err) {
    console.error("❌ Transfer Error:", err);
    res.status(500).json({ error: err.message });
  }
});




const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`API listening on ${PORT}`));
