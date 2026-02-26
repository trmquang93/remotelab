import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { execFileSync, spawn } from 'child_process';
import { createConnection } from 'net';
import { SESSIONS_FILE, SOCKET_DIR, TTYD_PORT_RANGE_START, TTYD_PORT_RANGE_END } from './config.mjs';

// ---------------------------------------------------------------------------
// Per-session ttyd process management
// ---------------------------------------------------------------------------
const sessionProcesses = new Map(); // sessionId -> { port, process }

const allocatedPorts = new Set();

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: 'localhost' });
    sock.once('connect', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => { sock.destroy(); resolve(true); });
  });
}

async function getAvailablePort() {
  for (let port = TTYD_PORT_RANGE_START; port <= TTYD_PORT_RANGE_END; port++) {
    if (allocatedPorts.has(port)) continue;
    if (await isPortAvailable(port)) {
      allocatedPorts.add(port);
      return port;
    }
  }
  throw new Error('No available ports in ttyd range');
}

function findTtydPath() {
  try {
    return execFileSync('which', ['ttyd'], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    // Fallback common locations
    for (const p of ['/opt/homebrew/bin/ttyd', '/usr/local/bin/ttyd']) {
      if (existsSync(p)) return p;
    }
    throw new Error('ttyd not found');
  }
}

function findWrapperPath() {
  const home = process.env.HOME || '';
  const candidates = [
    join(home, '.local', 'bin', 'claude-ttyd-session'),
    join(dirname(new URL(import.meta.url).pathname), '..', 'claude-ttyd-session'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('claude-ttyd-session wrapper not found');
}

let ttydPath;
let wrapperPath;

try {
  ttydPath = findTtydPath();
  wrapperPath = findWrapperPath();
  console.log(`ttyd path: ${ttydPath}`);
  console.log(`wrapper path: ${wrapperPath}`);
} catch (err) {
  console.error('Session ttyd init warning:', err.message);
}

export async function spawnSessionTtyd(session) {
  if (sessionProcesses.has(session.id)) {
    return sessionProcesses.get(session.id).port;
  }

  const port = await getAvailablePort();
  const socketName = getSessionSocketName(session);
  const toolCmd = session.type === 'shell' ? 'shell' : (session.tool || 'claude');

  const args = [
    '--writable',
    '--port', String(port),
    '--interface', 'lo0',
    '--ping-interval', '30',
    '--max-clients', '0',
    '--client-option', 'scrollback=10000',
    '--base-path', `/terminal/${session.id}`,
    wrapperPath, socketName, session.folder, toolCmd,
  ];

  const ttyd = spawn(ttydPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  ttyd.stdout.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[ttyd:${session.id.slice(0, 8)}] ${msg}`);
  });
  ttyd.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[ttyd:${session.id.slice(0, 8)}] ${msg}`);
  });

  ttyd.on('exit', (code) => {
    console.log(`[ttyd:${session.id.slice(0, 8)}] exited with code ${code}`);
    allocatedPorts.delete(port);
    sessionProcesses.delete(session.id);
  });

  sessionProcesses.set(session.id, { port, process: ttyd });
  console.log(`Spawned ttyd for session ${session.id.slice(0, 8)} on port ${port}`);
  return port;
}

export function killSessionTtyd(sessionId) {
  const entry = sessionProcesses.get(sessionId);
  if (entry) {
    try {
      entry.process.kill('SIGTERM');
    } catch {}
    allocatedPorts.delete(entry.port);
    sessionProcesses.delete(sessionId);
  }
}

export function getSessionPort(sessionId) {
  const entry = sessionProcesses.get(sessionId);
  return entry ? entry.port : null;
}

export function killAllSessionTtyd() {
  for (const [id, entry] of sessionProcesses) {
    try {
      entry.process.kill('SIGTERM');
    } catch {}
  }
  sessionProcesses.clear();
  allocatedPorts.clear();
}

export async function respawnAllSessions() {
  const sessions = loadSessions();
  console.log(`Respawning ttyd for ${sessions.length} saved sessions...`);
  for (const session of sessions) {
    try {
      await spawnSessionTtyd(session);
    } catch (err) {
      console.error(`Failed to spawn ttyd for session ${session.id}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Session persistence (unchanged logic)
// ---------------------------------------------------------------------------

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
  return randomBytes(16).toString('hex');
}

export function sessionExists(name) {
  return existsSync(join(SOCKET_DIR, `${name}.dtach`));
}

export function killSession(name) {
  const socketPath = join(SOCKET_DIR, `${name}.dtach`);
  if (!socketPath.startsWith(SOCKET_DIR + '/')) return;
  try {
    const pids = execFileSync('lsof', ['-t', socketPath], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
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

export function getSessionSocketName(session) {
  if (session.type === 'shell') {
    return `shell-${session.id}`;
  }
  const tool = session.tool || 'claude';
  return `${tool}-${session.id}`;
}

export function getSessionsByFolder() {
  const sessions = loadSessions();
  const folderMap = new Map();

  for (const s of sessions) {
    const folder = s.folder || 'unknown';
    if (!folderMap.has(folder)) {
      folderMap.set(folder, []);
    }
    folderMap.get(folder).push(s);
  }

  const result = [];
  for (const [folder, folderSessions] of folderMap) {
    const activeCount = folderSessions.filter(s =>
      sessionExists(getSessionSocketName(s))
    ).length;
    result.push({ folder, sessions: folderSessions, activeCount });
  }

  return result;
}
