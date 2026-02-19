import { homedir } from 'os';
import { join } from 'path';

function validPort(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function validMs(val, min, max, fallback) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export const LISTEN_PORT = validPort(process.env.LISTEN_PORT, 7681);
export const TTYD_PORT = validPort(process.env.TTYD_PORT, 7682);
export const SESSION_EXPIRY = validMs(
  process.env.SESSION_EXPIRY,
  60 * 1000,          // min: 1 minute
  30 * 24 * 60 * 60 * 1000, // max: 30 days
  24 * 60 * 60 * 1000  // default: 24 hours
);
export const SECURE_COOKIES = process.env.SECURE_COOKIES !== '0';

const configDir = join(homedir(), '.config', 'claude-web');

export const AUTH_FILE = join(configDir, 'auth.json');
export const SESSIONS_FILE = join(configDir, 'sessions.json');
export const TOOLS_FILE = join(configDir, 'tools.json');
export const AUTH_SESSIONS_FILE = join(configDir, 'auth-sessions.json');
export const SOCKET_DIR = join(configDir, 'sockets');
