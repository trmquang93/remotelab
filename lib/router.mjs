import { existsSync, mkdirSync, statSync, readdirSync, writeFileSync, unlinkSync, realpathSync, readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { parse as parseUrl } from 'url';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { SESSION_EXPIRY, UPLOADS_DIR } from './config.mjs';
import {
  auth, sessions, saveAuthSessions,
  verifyPassword, generateToken, isAuthenticated,
  parseCookies, setCookie, clearCookie
} from './auth.mjs';
import { loadSessions, saveSessions, generateId, sessionExists, killSession, getSessionSocketName, getSessionsByFolder, spawnSessionTtyd, killSessionTtyd } from './sessions.mjs';
import { getAvailableTools, addTool, removeTool, isToolValid } from './tools.mjs';
import { getGitDiff } from './git-diff.mjs';
import { addClient, removeClient, getLatestImageEvent, recordImageEvent, configureHook, isHookConfigured } from './image-preview.mjs';
import { loginPage, dashboardPage, folderViewPage } from './templates.mjs';
import { proxyToTtyd, proxyToCodeServer, proxyCodeServerCatchAll } from './proxy.mjs';
import { spawnCodeServer, stopCodeServer, getCodeServerStatus, isCodeServerInstalled, installCodeServer } from './code-server.mjs';
import { escapeHtml, escapeJs, readBody, readBodyRaw } from './utils.mjs';

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

  // Proxy code-server requests before CSP headers — code-server serves its
  // own HTML/JS and must not inherit our Content-Security-Policy.
  if (pathname.startsWith('/code/')) {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { 'Location': '/login' });
      res.end();
      return;
    }
    proxyToCodeServer(req, res);
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

  // Image preview event from hook (no auth — called from localhost by hook script)
  if (pathname === '/api/image-preview' && req.method === 'POST') {
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
      const { filePath } = JSON.parse(body);
      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'filePath is required' }));
        return;
      }

      const sessionsList = loadSessions();
      const folders = [...new Set(sessionsList.map(s => s.folder))];
      let resolvedFile;
      try { resolvedFile = realpathSync(resolve(filePath)); } catch { resolvedFile = resolve(filePath); }
      const matchingFolder = folders.find(f => {
        let realFolder;
        try { realFolder = realpathSync(f); } catch { realFolder = f; }
        return resolvedFile.startsWith(realFolder + '/') || resolvedFile === realFolder;
      });

      if (matchingFolder) {
        recordImageEvent(matchingFolder, resolvedFile);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  // All other requests require authentication
  if (!isAuthenticated(req)) {
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return;
  }

  // Session management API endpoints
  if (pathname === '/api/tools' && req.method === 'GET') {
    const tools = getAvailableTools();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools }));
    return;
  }

  if (pathname === '/api/tools' && req.method === 'POST') {
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
      const { id, name, command } = JSON.parse(body);
      if (!id || !name || !command) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'id, name, and command are required' }));
        return;
      }
      const tool = addTool({ id, name, command });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tool }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Invalid request body' }));
    }
    return;
  }

  if (pathname.startsWith('/api/tools/') && req.method === 'DELETE') {
    if (isApiRateLimited(getClientIp(req))) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }

    const toolId = pathname.split('/').pop();
    try {
      removeTool(toolId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      const status = err.message.includes('Cannot remove') ? 400 : 404;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/api/folders' && req.method === 'GET') {
    const folders = getSessionsByFolder();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ folders }));
    return;
  }

  if (pathname === '/api/sessions' && req.method === 'GET') {
    const sessionsList = loadSessions();
    const folderFilter = parsedUrl.query.folder;
    const filtered = folderFilter
      ? sessionsList.filter(s => s.folder === folderFilter)
      : sessionsList;
    const sessionsWithStatus = filtered.map(s => ({
      ...s,
      active: sessionExists(getSessionSocketName(s))
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
      const { name, folder, tool, type } = JSON.parse(body);

      if (!name || !folder) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Name and folder are required' }));
        return;
      }

      const isShell = type === 'shell';

      if (!isShell && tool && !isToolValid(tool)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown tool: ${tool}` }));
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
        tool: isShell ? 'shell' : (tool || 'claude'),
        type: isShell ? 'shell' : 'tool',
        created: new Date().toISOString()
      };

      const sessionsList = loadSessions();
      sessionsList.push(session);
      saveSessions(sessionsList);

      try {
        await spawnSessionTtyd(session);
      } catch (err) {
        console.error('Failed to spawn ttyd for session:', err.message);
      }

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

    killSessionTtyd(id);
    killSession(getSessionSocketName(sessionsList[sessionIndex]));

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

  // File upload (browser -> server filesystem)
  if (pathname === '/api/upload-file' && req.method === 'POST') {
    if (isApiRateLimited(getClientIp(req))) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }

    const MAX_FILE_SIZE = 25 * 1024 * 1024;
    const rawFilename = req.headers['x-filename'] || '';

    if (!rawFilename) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'X-Filename header is required' }));
      return;
    }

    // Sanitize filename: strip path separators, reject traversal
    const sanitized = basename(rawFilename).replace(/[\x00-\x1f]/g, '');
    if (!sanitized || sanitized === '.' || sanitized === '..' || sanitized.length > 255) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid filename' }));
      return;
    }

    // Save to dedicated uploads directory (not the session working folder)
    mkdirSync(UPLOADS_DIR, { recursive: true });

    let buf;
    try {
      buf = await readBodyRaw(req, MAX_FILE_SIZE);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large (max 25MB)' }));
        return;
      }
      throw err;
    }

    // Determine unique destination path
    const ext = sanitized.includes('.') ? sanitized.slice(sanitized.lastIndexOf('.')) : '';
    const base = ext ? sanitized.slice(0, -ext.length) : sanitized;
    let destPath = join(UPLOADS_DIR, sanitized);
    let counter = 1;
    while (existsSync(destPath)) {
      destPath = join(UPLOADS_DIR, `${base} (${counter})${ext}`);
      counter++;
    }

    try {
      writeFileSync(destPath, buf);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: destPath }));
    } catch (err) {
      console.error('File upload write error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to write file' }));
    }
    return;
  }

  // Clipboard image paste (browser -> macOS pasteboard)
  if (pathname === '/api/clipboard-image' && req.method === 'POST') {
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
      body = await readBody(req, 14 * 1024 * 1024); // ~10MB image base64-encoded
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Image too large (max 10MB)' }));
        return;
      }
      throw err;
    }

    try {
      const { image } = JSON.parse(body);
      if (!image || typeof image !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'image field is required' }));
        return;
      }

      // Strip data URI prefix if present
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(base64Data, 'base64');

      // Validate it looks like a PNG or JPEG
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
      if (!isPng && !isJpeg) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid image data' }));
        return;
      }

      const tmpPath = join(tmpdir(), `remotelab-clipboard-${randomBytes(8).toString('hex')}.png`);
      writeFileSync(tmpPath, buf);

      try {
        execFileSync('osascript', [
          '-e', `set the clipboard to (read (POSIX file "${tmpPath}") as «class PNGf»)`
        ], { timeout: 5000 });
      } finally {
        try { unlinkSync(tmpPath); } catch {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('Clipboard image error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to set clipboard' }));
    }
    return;
  }

  // Image preview SSE events
  if (pathname === '/api/image-preview/events' && req.method === 'GET') {
    const folder = parsedUrl.query.folder;
    if (!folder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'folder parameter required' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(':\n\n'); // SSE comment to keep alive
    addClient(folder, res);
    req.on('close', () => removeClient(folder, res));
    return;
  }

  // Image preview latest event
  if (pathname === '/api/image-preview/latest' && req.method === 'GET') {
    const folder = parsedUrl.query.folder;
    if (!folder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'folder parameter required' }));
      return;
    }
    const event = getLatestImageEvent(folder);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(event || {}));
    return;
  }

  // Image preview file serve
  if (pathname === '/api/image-preview/file' && req.method === 'GET') {
    const folder = parsedUrl.query.folder;
    const filePath = parsedUrl.query.path;
    if (!folder || !filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('folder and path parameters required');
      return;
    }

    // Security: validate folder is an actual session folder
    const allSessions = loadSessions();
    const knownFolders = new Set(allSessions.map(s => {
      try { return realpathSync(resolve(s.folder)); } catch { return resolve(s.folder); }
    }));
    let resolvedRequestedFolder;
    try { resolvedRequestedFolder = realpathSync(resolve(folder)); } catch { resolvedRequestedFolder = resolve(folder); }
    if (!knownFolders.has(resolvedRequestedFolder)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Access denied');
      return;
    }

    // Security: ensure the requested file is within the folder (resolve symlinks)
    let resolvedFile, resolvedFolder;
    try { resolvedFile = realpathSync(resolve(filePath)); } catch { resolvedFile = resolve(filePath); }
    try { resolvedFolder = realpathSync(resolve(folder)); } catch { resolvedFolder = resolve(folder); }
    if (!resolvedFile.startsWith(resolvedFolder + '/') && resolvedFile !== resolvedFolder) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Access denied');
      return;
    }

    const mimeMap = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      bmp: 'image/bmp', ico: 'image/x-icon'
    };
    const ext = resolvedFile.split('.').pop().toLowerCase();
    if (!mimeMap[ext]) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Not a supported image type');
      return;
    }

    try {
      const stat = statSync(resolvedFile);
      if (stat.size > 50 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('File too large (max 50MB)');
        return;
      }
      const data = readFileSync(resolvedFile);
      res.writeHead(200, { 'Content-Type': mimeMap[ext] });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
    }
    return;
  }

  // Image preview hook toggle
  if (pathname === '/api/image-preview/hook' && req.method === 'POST') {
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
      const { folder, enable } = JSON.parse(body);
      if (!folder) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'folder is required' }));
        return;
      }

      // Validate folder is an actual session folder
      const hookSessions = loadSessions();
      const hookKnownFolders = new Set(hookSessions.map(s => {
        try { return realpathSync(resolve(s.folder)); } catch { return resolve(s.folder); }
      }));
      let hookResolvedFolder;
      try { hookResolvedFolder = realpathSync(resolve(folder)); } catch { hookResolvedFolder = resolve(folder); }
      if (!hookKnownFolders.has(hookResolvedFolder)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access denied' }));
        return;
      }

      await configureHook(folder, !!enable);
      const configured = await isHookConfigured(folder);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: configured }));
    } catch (err) {
      console.error('Image preview hook error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to configure hook' }));
    }
    return;
  }

  // Image preview hook status
  if (pathname === '/api/image-preview/hook' && req.method === 'GET') {
    const folder = parsedUrl.query.folder;
    if (!folder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'folder parameter required' }));
      return;
    }
    try {
      const configured = await isHookConfigured(folder);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: configured }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to check hook status' }));
    }
    return;
  }

  // code-server API: check if installed
  if (pathname === '/api/code-server/installed' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ installed: isCodeServerInstalled() }));
    return;
  }

  // code-server API: install
  if (pathname === '/api/code-server/install' && req.method === 'POST') {
    if (isApiRateLimited(getClientIp(req))) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }

    try {
      const result = await installCodeServer();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('code-server install error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // code-server API: start
  if (pathname === '/api/code-server/start' && req.method === 'POST') {
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
      const { folder } = JSON.parse(body);
      if (!folder) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'folder is required' }));
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

      const port = await spawnCodeServer(resolvedFolder);
      const url = `/code/${encodeURIComponent(resolvedFolder)}/`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ port, url }));
    } catch (err) {
      console.error('code-server start error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // code-server API: stop
  if (pathname === '/api/code-server/stop' && req.method === 'POST') {
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
      const { folder } = JSON.parse(body);
      if (!folder) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'folder is required' }));
        return;
      }

      stopCodeServer(folder);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  // code-server API: status
  if (pathname === '/api/code-server/status' && req.method === 'GET') {
    const folder = parsedUrl.query.folder;
    if (!folder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'folder parameter required' }));
      return;
    }

    const status = getCodeServerStatus(folder);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  // Folder view page
  if (pathname.startsWith('/folder/')) {
    const encodedPath = pathname.slice('/folder/'.length);
    if (!encodedPath) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Folder path required');
      return;
    }

    const folderPath = decodeURIComponent(encodedPath);
    const resolvedFolder = folderPath.startsWith('~')
      ? join(homedir(), folderPath.slice(1))
      : resolve(folderPath);

    const html = folderViewPage
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{FOLDER_PATH_HTML\}\}/g, escapeHtml(resolvedFolder))
      .replace(/\{\{FOLDER_PATH_URL\}\}/g, encodeURIComponent(resolvedFolder))
      .replace(/\{\{FOLDER_PATH_JS\}\}/g, escapeJs(resolvedFolder));

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

  // Catch-all: proxy unmatched paths to code-server if a cs_folder cookie
  // is set. Code-server loads assets at absolute paths (/stable-xxx/...) that
  // don't carry the /code/<folder>/ prefix.
  if (proxyCodeServerCatchAll(req, res)) return;

  // 404 for any other paths
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}
