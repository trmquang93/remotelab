import http from 'http';
import net from 'net';
import { parse as parseUrl } from 'url';
import { isAuthenticated } from './auth.mjs';
import { getSessionPort } from './sessions.mjs';
import { getCodeServerPort } from './code-server.mjs';

function extractSessionId(pathname) {
  // /terminal/<sessionId>/...
  const match = pathname.match(/^\/terminal\/([^/]+)/);
  return match ? match[1] : null;
}

function getPortForRequest(pathname) {
  const sessionId = extractSessionId(pathname);
  if (!sessionId) return null;
  return getSessionPort(sessionId);
}

function rewritePath(pathname, sessionId) {
  // ttyd expects requests relative to its --base-path (/terminal/<sessionId>)
  // so we forward the path as-is since ttyd's base-path matches
  return pathname;
}

// ---------------------------------------------------------------------------
// code-server proxy helpers
// ---------------------------------------------------------------------------

function extractFolderFromCodePath(pathname) {
  // /code/<encodedFolder>/...
  const match = pathname.match(/^\/code\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function getCodeServerPortForRequest(pathname) {
  const folder = extractFolderFromCodePath(pathname);
  if (!folder) return null;
  return getCodeServerPort(folder);
}

function rewriteCodePath(pathname) {
  // Strip /code/<encodedFolder> prefix, forward the remainder to code-server
  const match = pathname.match(/^\/code\/[^/]+(\/.*)?$/);
  return match ? (match[1] || '/') : '/';
}

export function proxyToCodeServer(req, res) {
  const parsedUrl = parseUrl(req.url);
  const port = getCodeServerPortForRequest(parsedUrl.pathname);

  if (!port) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Code server not found for this folder');
    return;
  }

  const folder = extractFolderFromCodePath(parsedUrl.pathname);
  const rewrittenPath = rewriteCodePath(parsedUrl.pathname) + (parsedUrl.search || '');

  // Set cookie so subsequent absolute-path requests (assets, WS) route to
  // the correct code-server instance via the catch-all proxy.
  const cookieHeader = `cs_folder=${encodeURIComponent(folder)}; Path=/; HttpOnly; SameSite=Lax`;

  const options = {
    hostname: 'localhost',
    port,
    path: rewrittenPath,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${port}` },
  };

  const proxyReq = http.request(options, proxyRes => {
    // Inject our cookie alongside any Set-Cookie from code-server
    const existing = proxyRes.headers['set-cookie'] || [];
    const cookies = Array.isArray(existing) ? existing : [existing];
    cookies.push(cookieHeader);
    proxyRes.headers['set-cookie'] = cookies;
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    console.error('Code-server proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq);
}

// Catch-all proxy for code-server absolute-path requests (assets, API).
// Uses cs_folder cookie set when /code/<folder>/ was first visited.
export function proxyCodeServerCatchAll(req, res) {
  const port = getCodeServerPortFromCookie(req);
  if (!port) return false;

  const options = {
    hostname: 'localhost',
    port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${port}` },
  };

  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    console.error('Code-server catch-all proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq);
  return true;
}

function parseCookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function getCodeServerPortFromCookie(req) {
  const folder = parseCookieValue(req.headers.cookie, 'cs_folder');
  if (!folder) return null;
  return getCodeServerPort(folder);
}

export function proxyToTtyd(req, res) {
  const parsedUrl = parseUrl(req.url);
  const port = getPortForRequest(parsedUrl.pathname);

  if (!port) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Session not found');
    return;
  }

  const options = {
    hostname: 'localhost',
    port,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  const proxyReq = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    console.error('Proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq);
}

export function handleWebSocketUpgrade(req, socket, head) {
  const parsedUrl = parseUrl(req.url);
  const pathname = parsedUrl.pathname;

  const isTerminal = pathname.startsWith('/terminal/');
  const isCode = pathname.startsWith('/code/');
  // code-server opens WebSockets at absolute paths (no /code/ prefix);
  // detect these via the cs_folder cookie set during the initial page load.
  const csPort = !isTerminal && !isCode ? getCodeServerPortFromCookie(req) : null;

  if (!isTerminal && !isCode && !csPort) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!isAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  let port;
  let forwardUrl = req.url;

  if (isTerminal) {
    port = getPortForRequest(pathname);
  } else if (isCode) {
    port = getCodeServerPortForRequest(pathname);
    const rewritten = rewriteCodePath(pathname);
    forwardUrl = rewritten + (parsedUrl.search || '');
  } else {
    // Absolute-path WebSocket from code-server (cookie-based)
    port = csPort;
  }

  if (!port) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Sanitize forwardUrl to prevent CRLF / header injection
  const sanitizedUrl = forwardUrl.replace(/[\r\n]/g, '');

  const upstream = net.connect(port, 'localhost', () => {
    let httpReq = `${req.method} ${sanitizedUrl} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].replace(/[\r\n]/g, '');
      const lower = name.toLowerCase();
      let value = req.rawHeaders[i + 1].replace(/[\r\n]/g, '');
      if (lower === 'host') {
        value = `localhost:${port}`;
      } else if (lower === 'origin') {
        value = `http://localhost:${port}`;
      }
      httpReq += `${name}: ${value}\r\n`;
    }
    httpReq += '\r\n';
    upstream.write(httpReq);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on('error', err => {
    console.error('WebSocket proxy error:', err.message);
    socket.destroy();
  });
}
