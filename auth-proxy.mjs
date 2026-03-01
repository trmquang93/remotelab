#!/usr/bin/env node
import http from 'http';
import { LISTEN_PORT, SECURE_COOKIES } from './lib/config.mjs';
import { handleRequest } from './lib/router.mjs';
import { handleWebSocketUpgrade } from './lib/proxy.mjs';
import { respawnAllSessions, killAllSessionTtyd } from './lib/sessions.mjs';
import { stopAllCodeServers } from './lib/code-server.mjs';

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

// Graceful shutdown: kill all child ttyd processes
function shutdown() {
  console.log('Shutting down, killing ttyd and code-server processes...');
  killAllSessionTtyd();
  stopAllCodeServers();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(LISTEN_PORT, 'localhost', async () => {
  console.log(`Auth proxy listening on http://localhost:${LISTEN_PORT}`);
  console.log(`Cookie mode: ${SECURE_COOKIES ? 'Secure (HTTPS)' : 'Non-secure (localhost)'}`);

  // Respawn ttyd for all existing sessions
  try {
    await respawnAllSessions();
  } catch (err) {
    console.error('Failed to respawn sessions:', err.message);
  }
});
