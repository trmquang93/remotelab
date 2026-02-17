import { existsSync, statSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { parse as parseUrl } from 'url';
import { randomBytes } from 'crypto';
import { SESSION_EXPIRY } from './config.mjs';
import {
  auth, sessions, saveAuthSessions,
  verifyPassword, generateToken, isAuthenticated,
  parseCookies, setCookie, clearCookie
} from './auth.mjs';
import { loadSessions, saveSessions, generateId, sessionExists, killSession } from './sessions.mjs';
import { getGitDiff } from './git-diff.mjs';
import { loginPage, dashboardPage, sessionViewPage } from './templates.mjs';
import { proxyToTtyd } from './proxy.mjs';
import { escapeHtml, escapeJs, readBody } from './utils.mjs';

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // base window: 1 minute
const MAX_TRACKED_IPS = 10000;

const failedAttempts = new Map(); // IP -> { count, lockedUntil }

setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of failedAttempts) {
    if (state.lockedUntil && state.lockedUntil < now - 15 * 60 * 1000) {
      failedAttempts.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Authenticated API rate limiter (write operations)
const API_RATE_LIMIT = 30;
const API_RATE_WINDOW_MS = 60 * 1000;

const apiRateLimits = new Map(); // IP -> { count, resetAt }

setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of apiRateLimits) {
    if (state.resetAt < now) {
      apiRateLimits.delete(ip);
    }
  }
}, 60 * 1000);

function isApiRateLimited(ip) {
  const now = Date.now();
  const state = apiRateLimits.get(ip);
  if (!state || state.resetAt < now) {
    apiRateLimits.set(ip, { count: 1, resetAt: now + API_RATE_WINDOW_MS });
    if (apiRateLimits.size > MAX_TRACKED_IPS) {
      apiRateLimits.delete(apiRateLimits.keys().next().value);
    }
    return false;
  }
  if (state.count >= API_RATE_LIMIT) return true;
  state.count += 1;
  return false;
}

function getClientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function isRateLimited(ip) {
  const state = failedAttempts.get(ip);
  if (!state) return false;
  if (state.lockedUntil && Date.now() < state.lockedUntil) return true;
  return false;
}

function recordFailedAttempt(ip) {
  const state = failedAttempts.get(ip) || { count: 0, lockedUntil: null };
  state.count += 1;

  if (state.count >= RATE_LIMIT_MAX) {
    // Exponential backoff: 1 min, 2 min, 4 min, ... capped at 15 min
    const exponent = state.count - RATE_LIMIT_MAX;
    const backoffMs = Math.min(RATE_LIMIT_WINDOW_MS * Math.pow(2, exponent), 15 * 60 * 1000);
    state.lockedUntil = Date.now() + backoffMs;
  }

  failedAttempts.set(ip, state);
  if (failedAttempts.size > MAX_TRACKED_IPS) {
    failedAttempts.delete(failedAttempts.keys().next().value);
  }
}

function clearFailedAttempts(ip) {
  failedAttempts.delete(ip);
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-UA-Compatible': 'IE=edge',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

function setSecurityHeaders(res, nonce) {
  for (const [key, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:"
  ].join('; '));
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------
export async function handleRequest(req, res) {
  const parsedUrl = parseUrl(req.url, true);
  const pathname = parsedUrl.pathname;

  // Proxy terminal requests to ttyd before setting any headers — ttyd serves
  // its own HTML with inline scripts/styles and must not inherit our CSP.
  if (pathname.startsWith('/terminal/') || pathname === '/terminal') {
    proxyToTtyd(req, res);
    return;
  }

  const nonce = randomBytes(16).toString('base64');
  setSecurityHeaders(res, nonce);

  // Login page
  if (pathname === '/login' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(loginPage.replace('{{NONCE}}', nonce).replace('{{ERROR}}', ''));
    return;
  }

  // Login form submission
  if (pathname === '/login' && req.method === 'POST') {
    const ip = getClientIp(req);

    if (isRateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
      res.end('Too many failed login attempts. Please try again later.');
      return;
    }

    let body;
    try {
      body = await readBody(req, 10240);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('Request body too large');
        return;
      }
      throw err;
    }

    const params = new URLSearchParams(body);
    const username = params.get('username');
    const password = params.get('password');

    if (username === auth.username && verifyPassword(password)) {
      clearFailedAttempts(ip);
      const token = generateToken();
      sessions.set(token, { expiry: Date.now() + SESSION_EXPIRY });
      saveAuthSessions();

      res.writeHead(302, {
        'Location': '/',
        'Set-Cookie': setCookie(token)
      });
      res.end();
    } else {
      recordFailedAttempt(ip);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(loginPage.replace('{{NONCE}}', nonce).replace('{{ERROR}}', '<div class="error">Invalid username or password</div>'));
    }
    return;
  }

  // Logout
  if (pathname === '/logout') {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies.session_token;
    if (token) {
      sessions.delete(token);
      saveAuthSessions();
    }

    res.writeHead(302, {
      'Location': '/login',
      'Set-Cookie': clearCookie()
    });
    res.end();
    return;
  }

  // All other requests require authentication
  if (!isAuthenticated(req)) {
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return;
  }

  // Session management API endpoints
  if (pathname === '/api/sessions' && req.method === 'GET') {
    const sessionsList = loadSessions();
    const sessionsWithStatus = sessionsList.map(s => ({
      ...s,
      active: sessionExists(`claude-${s.id}`)
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: sessionsWithStatus }));
    return;
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    if (isApiRateLimited(getClientIp(req))) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
      return;
    }

    let body;
    try {
      body = await readBody(req, 10240);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
      throw err;
    }

    try {
      const { name, folder } = JSON.parse(body);

      if (!name || !folder) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Name and folder are required' }));
        return;
      }

      const resolvedFolder = folder.startsWith('~')
        ? join(homedir(), folder.slice(1))
        : resolve(folder);

      if (!existsSync(resolvedFolder) || !statSync(resolvedFolder).isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Folder does not exist' }));
        return;
      }

      const id = generateId();
      const session = {
        id,
        name,
        folder: resolvedFolder,
        created: new Date().toISOString()
      };

      const sessionsList = loadSessions();
      sessionsList.push(session);
      saveSessions(sessionsList);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
    if (isApiRateLimited(getClientIp(req))) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }

    const id = pathname.split('/').pop();
    const sessionsList = loadSessions();
    const sessionIndex = sessionsList.findIndex(s => s.id === id);

    if (sessionIndex === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    killSession(`claude-${id}`);

    sessionsList.splice(sessionIndex, 1);
    saveSessions(sessionsList);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === '/api/autocomplete' && req.method === 'GET') {
    const query = parsedUrl.query.q || '';
    const suggestions = [];

    try {
      const resolvedQuery = query.startsWith('~')
        ? join(homedir(), query.slice(1))
        : query;

      const parentDir = dirname(resolvedQuery);
      const prefix = basename(resolvedQuery);

      if (existsSync(parentDir) && statSync(parentDir).isDirectory()) {
        const entries = readdirSync(parentDir);

        for (const entry of entries) {
          if (!prefix.startsWith('.') && entry.startsWith('.')) continue;

          const fullPath = join(parentDir, entry);
          if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
            if (entry.toLowerCase().startsWith(prefix.toLowerCase())) {
              suggestions.push(fullPath);
            }
          }
        }
      }
    } catch (err) {
      console.error('Autocomplete error:', err.message);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ suggestions: suggestions.slice(0, 20) }));
    return;
  }

  if (pathname === '/api/browse' && req.method === 'GET') {
    const pathQuery = parsedUrl.query.path || '~';
    const showHidden = parsedUrl.query.hidden === '1';

    try {
      const resolvedPath = pathQuery === '~' || pathQuery === ''
        ? homedir()
        : pathQuery.startsWith('~')
          ? join(homedir(), pathQuery.slice(1))
          : resolve(pathQuery);

      const children = [];
      let parent = null;

      if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
        const parentPath = dirname(resolvedPath);
        parent = parentPath !== resolvedPath ? parentPath : null;

        const entries = readdirSync(resolvedPath);
        for (const entry of entries) {
          if (entry.startsWith('.') && !showHidden) continue;

          const fullPath = join(resolvedPath, entry);
          try {
            if (statSync(fullPath).isDirectory()) {
              children.push({ name: entry, path: fullPath });
            }
          } catch {
            // Skip entries we can't stat
          }
        }

        children.sort((a, b) => a.name.localeCompare(b.name));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: resolvedPath, parent, children }));
    } catch (err) {
      console.error('Browse error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to browse directory' }));
    }
    return;
  }

  if (pathname === '/api/diff' && req.method === 'GET') {
    const folder = parsedUrl.query.folder;

    if (!folder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Folder parameter is required' }));
      return;
    }

    try {
      const diffData = getGitDiff(folder);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(diffData));
    } catch (err) {
      console.error('Diff error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get diff' }));
    }
    return;
  }

  // Session view page
  if (pathname.startsWith('/session/')) {
    const sessionId = pathname.split('/')[2];
    if (!sessionId) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Session ID required');
      return;
    }

    const sessionsList = loadSessions();
    const session = sessionsList.find(s => s.id === sessionId);

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Session not found');
      return;
    }

    const html = sessionViewPage
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{SESSION_ID\}\}/g, session.id)
      .replace(/\{\{SESSION_ID_URL\}\}/g, encodeURIComponent(session.id))
      .replace(/\{\{SESSION_ID_JS\}\}/g, escapeJs(session.id))
      .replace(/\{\{SESSION_NAME_HTML\}\}/g, escapeHtml(session.name))
      .replace(/\{\{SESSION_FOLDER_HTML\}\}/g, escapeHtml(session.folder))
      .replace(/\{\{SESSION_FOLDER_URL\}\}/g, encodeURIComponent(session.folder))
      .replace(/\{\{SESSION_FOLDER_JS\}\}/g, escapeJs(session.folder));

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // Dashboard
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(dashboardPage.replace(/\{\{NONCE\}\}/g, nonce));
    return;
  }

  // 404 for any other paths
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}
