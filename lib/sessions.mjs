import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { SESSIONS_FILE, SOCKET_DIR } from './config.mjs';

export function loadSessions() {
  try {
    if (!existsSync(SESSIONS_FILE)) {
      return [];
    }
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to load sessions.json:', err.message);
    return [];
  }
}

export function saveSessions(sessionsList) {
  try {
    const configDir = dirname(SESSIONS_FILE);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsList, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save sessions.json:', err.message);
  }
}

export function generateId() {
  return randomBytes(4).toString('hex');
}

export function sessionExists(name) {
  return existsSync(join(SOCKET_DIR, `${name}.dtach`));
}

export function killSession(name) {
  const socketPath = join(SOCKET_DIR, `${name}.dtach`);
  try {
    const pids = execSync(`lsof -t "${socketPath}" 2>/dev/null`).toString().trim();
    for (const pid of pids.split('\n').filter(Boolean)) {
      try {
        process.kill(parseInt(pid), 'SIGTERM');
      } catch {}
    }
  } catch {}
  try {
    unlinkSync(socketPath);
  } catch {}
}
