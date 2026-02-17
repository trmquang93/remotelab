import { existsSync, statSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { parse as parseUrl } from 'url';
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

export function handleRequest(req, res) {
  const parsedUrl = parseUrl(req.url, true);
  const pathname = parsedUrl.pathname;

  // Login page
  if (pathname === '/login' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(loginPage.replace('{{ERROR}}', ''));
    return;
  }

  // Login form submission
  if (pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const username = params.get('username');
      const password = params.get('password');

      if (username === auth.username && verifyPassword(password)) {
        const token = generateToken();
        sessions.set(token, { expiry: Date.now() + SESSION_EXPIRY });
        saveAuthSessions();

        res.writeHead(302, {
          'Location': '/',
          'Set-Cookie': setCookie(token)
        });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(loginPage.replace('{{ERROR}}', '<div class="error">Invalid username or password</div>'));
      }
    });
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
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
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
    });
    return;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
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
      .replace(/\{\{SESSION_ID\}\}/g, session.id)
      .replace(/\{\{SESSION_NAME\}\}/g, session.name)
      .replace(/\{\{SESSION_FOLDER\}\}/g, session.folder);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // Dashboard
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(dashboardPage);
    return;
  }

  // Proxy terminal requests to ttyd
  if (pathname.startsWith('/terminal/') || pathname === '/terminal') {
    proxyToTtyd(req, res);
    return;
  }

  // 404 for any other paths
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}
