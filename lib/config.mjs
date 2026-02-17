import { homedir } from 'os';
import { join } from 'path';

export const LISTEN_PORT = parseInt(process.env.LISTEN_PORT) || 7681;
export const TTYD_PORT = parseInt(process.env.TTYD_PORT) || 7682;
export const SESSION_EXPIRY = parseInt(process.env.SESSION_EXPIRY) || 24 * 60 * 60 * 1000;
export const SECURE_COOKIES = process.env.SECURE_COOKIES !== '0';

const configDir = join(homedir(), '.config', 'claude-web');

export const AUTH_FILE = join(configDir, 'auth.json');
export const SESSIONS_FILE = join(configDir, 'sessions.json');
export const AUTH_SESSIONS_FILE = join(configDir, 'auth-sessions.json');
export const SOCKET_DIR = join(configDir, 'sockets');
