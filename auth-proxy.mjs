#!/usr/bin/env node
import http from 'http';
import { LISTEN_PORT, TTYD_PORT, SECURE_COOKIES } from './lib/config.mjs';
import { handleRequest } from './lib/router.mjs';
import { handleWebSocketUpgrade } from './lib/proxy.mjs';

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('Unhandled request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });
});

server.on('upgrade', handleWebSocketUpgrade);

server.listen(LISTEN_PORT, 'localhost', () => {
  console.log(`Auth proxy listening on http://localhost:${LISTEN_PORT}`);
  console.log(`Proxying to ttyd on port ${TTYD_PORT}`);
  console.log(`Cookie mode: ${SECURE_COOKIES ? 'Secure (HTTPS)' : 'Non-secure (localhost)'}`);
});
