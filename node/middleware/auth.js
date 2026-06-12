// node/middleware/auth.js
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();
import pool from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'changeme';

// Helper: parse token from Authorization header
function getBearerToken(req) {
  const hdr = req.headers.authorization || req.headers.Authorization || null;
  if (!hdr) return null;
  const parts = hdr.split(' ');
  if (parts.length !== 2) return null;
  const [scheme, token] = parts;
  if (!/^Bearer$/i.test(scheme)) return null;
  return token;
}

// Middleware: verify JWT and attach user to req.user
export async function requireAuth(req, res, next) {
  console.log("step 2");
  try {
    const token = getBearerToken(req) || req.query.token || req.headers['x-access-token'];
    if (!token) return res.status(401).json({ status: 'error', message: 'token_missing' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ status: 'error', message: 'invalid_token' });
    }

    // payload.sub expected to be user id (as set in your login)
    const userId = payload.sub;
    if (!userId) return res.status(401).json({ status: 'error', message: 'invalid_token_payload' });

    // fetch user from DB and attach minimal fields
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT id, email, fullname, phone, is_active, kyc_status,is_admin FROM users WHERE id = ? LIMIT 1', [userId]);
      if (!rows.length) return res.status(401).json({ status: 'error', message: 'user_not_found' });
      const user = rows[0];
      if (!user.is_active) return res.status(403).json({ status: 'error', message: 'account_disabled' });
      console.log(user);
      // attach user to req
      req.user = {
        id: user.id,
        email: user.email,
        fullname: user.fullname,
        phone: user.phone,
        kyc_status: user.kyc_status,
        is_admin: user.is_admin
      };

      // attach isAdmin flag: check users table if you have is_admin column OR check ADMIN_IDS env
     /* const adminIdsEnv = process.env.ADMIN_IDS || '';
      const adminIds = adminIdsEnv.split(',').map(s => s.trim()).filter(Boolean).map(id => Number(id));
      req.user.is_admin = false;
      if (adminIds.includes(Number(user.id))) req.user.is_admin = true;
      */

      // if you have an is_admin column in users table uncomment below:
      // req.user.is_admin = rows[0].is_admin == 1;

    } finally {
      conn.release();
    }

    return next();
  } catch (err) {
    console.error('requireAuth error', err);
    return res.status(500).json({ status: 'error', message: 'internal_server_error' });
  }
}

// Middleware: admin-only guard
export function requireAdmin(req, res, next) {
  console.log(req.user);
  console.log("step 1");
  // if requireAuth not yet run, try to parse token (but prefer using requireAuth first)
  if (!req.user) return res.status(401).json({ status: 'error', message: 'auth_required' });

  if (!req.user.is_admin) return res.status(403).json({ status: 'error', message: 'admin_required' });

  return next();
}

// Optional helper to assert roles in routes
export function requireRole(roleCheckFn) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ status: 'error', message: 'auth_required' });
    try {
      if (!roleCheckFn(req.user)) return res.status(403).json({ status: 'error', message: 'forbidden' });
      return next();
    } catch (e) {
      return res.status(500).json({ status: 'error', message: 'internal_server_error' });
    }
  };
}
