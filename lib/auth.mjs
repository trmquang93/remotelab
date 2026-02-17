import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { AUTH_FILE, AUTH_SESSIONS_FILE, SESSION_EXPIRY, SECURE_COOKIES } from './config.mjs';

function loadAuth() {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to load auth.json:', err.message);
    process.exit(1);
  }
}

export const auth = loadAuth();

export function loadAuthSessions() {
  try {
    if (!existsSync(AUTH_SESSIONS_FILE)) {
      return new Map();
    }
    const data = JSON.parse(readFileSync(AUTH_SESSIONS_FILE, 'utf8'));
    const map = new Map();
    const now = Date.now();
    for (const [token, session] of Object.entries(data)) {
      if (session.expiry > now) {
        map.set(token, session);
      }
    }
    return map;
  } catch (err) {
    console.error('Failed to load auth-sessions.json:', err.message);
    return new Map();
  }
}

export function saveAuthSessions() {
  try {
    const configDir = dirname(AUTH_SESSIONS_FILE);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    const data = Object.fromEntries(sessions);
    writeFileSync(AUTH_SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save auth-sessions.json:', err.message);
  }
}

export const sessions = loadAuthSessions();

export function verifyPassword(password) {
  const hash = scryptSync(password, auth.salt, 64).toString('hex');
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(auth.hash, 'hex'));
}

export function generateToken() {
  return randomBytes(32).toString('hex');
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [key, value] = cookie.trim().split('=');
    if (key && value) cookies[key] = value;
  });
  return cookies;
}

export function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.session_token;

  if (!token) return false;

  const session = sessions.get(token);
  if (!session) return false;

  if (Date.now() > session.expiry) {
    sessions.delete(token);
    saveAuthSessions();
    return false;
  }

  return true;
}

export function setCookie(token) {
  const expiry = new Date(Date.now() + SESSION_EXPIRY);
  const secure = SECURE_COOKIES ? '; Secure' : '';
  return `session_token=${token}; HttpOnly${secure}; SameSite=Strict; Path=/; Expires=${expiry.toUTCString()}`;
}

export function clearCookie() {
  const secure = SECURE_COOKIES ? '; Secure' : '';
  return `session_token=; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=0`;
}
