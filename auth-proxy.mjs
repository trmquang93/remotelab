#!/usr/bin/env node
import http from 'http';
import { LISTEN_PORT, TTYD_PORT } from './lib/config.mjs';
import { handleRequest } from './lib/router.mjs';
import { handleWebSocketUpgrade } from './lib/proxy.mjs';

const server = http.createServer(handleRequest);

server.on('upgrade', handleWebSocketUpgrade);

server.listen(LISTEN_PORT, 'localhost', () => {
  console.log(`Auth proxy listening on http://localhost:${LISTEN_PORT}`);
  console.log(`Proxying to ttyd on port ${TTYD_PORT}`);
});
