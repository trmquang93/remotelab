import http from 'http';
import net from 'net';
import { parse as parseUrl } from 'url';
import { TTYD_PORT } from './config.mjs';
import { isAuthenticated } from './auth.mjs';

export function proxyToTtyd(req, res) {
  const options = {
    hostname: 'localhost',
    port: TTYD_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers
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

  if (!pathname.startsWith('/terminal/') && pathname !== '/terminal') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!isAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const ttydSocket = net.connect(TTYD_PORT, 'localhost', () => {
    let httpReq = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      httpReq += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    httpReq += '\r\n';
    ttydSocket.write(httpReq);
    if (head.length > 0) ttydSocket.write(head);
    socket.pipe(ttydSocket).pipe(socket);
  });

  ttydSocket.on('error', err => {
    console.error('WebSocket proxy error:', err.message);
    socket.destroy();
  });
}
