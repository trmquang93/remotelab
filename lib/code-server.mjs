import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync, spawn, execFile } from 'child_process';
import { createConnection } from 'net';
import { CS_PORT_RANGE_START, CS_PORT_RANGE_END } from './config.mjs';

// ---------------------------------------------------------------------------
// Per-folder code-server process management
// ---------------------------------------------------------------------------
const codeServerProcesses = new Map(); // folder -> { port, process }

const allocatedPorts = new Set();

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: 'localhost' });
    sock.once('connect', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => { sock.destroy(); resolve(true); });
  });
}

async function getAvailablePort() {
  for (let port = CS_PORT_RANGE_START; port <= CS_PORT_RANGE_END; port++) {
    if (allocatedPorts.has(port)) continue;
    if (await isPortAvailable(port)) {
      allocatedPorts.add(port);
      return port;
    }
  }
  throw new Error('No available ports in code-server range');
}

function findCodeServerPath() {
  try {
    return execFileSync('which', ['code-server'], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    for (const p of ['/opt/homebrew/bin/code-server', '/usr/local/bin/code-server']) {
      if (existsSync(p)) return p;
    }
    throw new Error('code-server not found');
  }
}

let codeServerPath;

try {
  codeServerPath = findCodeServerPath();
  console.log(`code-server path: ${codeServerPath}`);
} catch (err) {
  console.error('code-server init warning:', err.message);
}

export function isCodeServerInstalled() {
  return !!codeServerPath;
}

let installing = null; // shared promise to prevent concurrent installs

export function installCodeServer() {
  if (codeServerPath) {
    return Promise.resolve({ alreadyInstalled: true });
  }
  if (installing) {
    return installing;
  }

  installing = new Promise((resolve, reject) => {
    // Try brew first, fall back to the official install script
    const brewPath = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(p => existsSync(p));

    let cmd, args;
    if (brewPath) {
      cmd = brewPath;
      args = ['install', 'code-server'];
    } else {
      cmd = '/bin/sh';
      args = ['-c', 'curl -fsSL https://code-server.dev/install.sh | sh'];
    }

    console.log(`Installing code-server via: ${cmd} ${args.join(' ')}`);
    const child = execFile(cmd, args, { timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      installing = null;
      if (err) {
        console.error('code-server install error:', err.message);
        // Check if the binary was actually installed despite the error
        // (e.g. maxBuffer exceeded after brew already finished)
        try {
          codeServerPath = findCodeServerPath();
          console.log(`code-server found despite error: ${codeServerPath}`);
          resolve({ installed: true, path: codeServerPath });
          return;
        } catch (findErr) {
          console.warn(`code-server may have installed, but findCodeServerPath failed: ${findErr.message}`);
        }
        reject(new Error('Installation failed: ' + (err.message || 'unknown error')));
        return;
      }
      console.log('code-server install output:', stdout);
      // Re-resolve the binary path
      try {
        codeServerPath = findCodeServerPath();
        console.log(`code-server installed at: ${codeServerPath}`);
        resolve({ installed: true, path: codeServerPath });
      } catch (e) {
        reject(new Error('Installed but binary not found in PATH'));
      }
    });
  });

  return installing;
}

function folderHash(folder) {
  return createHash('sha256').update(folder).digest('hex').slice(0, 16);
}

export async function spawnCodeServer(folder) {
  if (codeServerProcesses.has(folder)) {
    return codeServerProcesses.get(folder).port;
  }

  if (!codeServerPath) {
    await installCodeServer();
  }

  const port = await getAvailablePort();
  const hash = folderHash(folder);
  const userDataDir = join(homedir(), '.config', 'claude-web', 'code-server', hash);
  mkdirSync(userDataDir, { recursive: true });

  const args = [
    '--port', String(port),
    '--host', '127.0.0.1',
    '--auth', 'none',
    '--user-data-dir', userDataDir,
    '--disable-getting-started-override',
    folder,
  ];

  const proc = spawn(codeServerPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const label = folder.split('/').pop() || hash.slice(0, 8);

  proc.stdout.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[code-server:${label}] ${msg}`);
  });
  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[code-server:${label}] ${msg}`);
  });

  proc.on('exit', (code) => {
    console.log(`[code-server:${label}] exited with code ${code}`);
    allocatedPorts.delete(port);
    codeServerProcesses.delete(folder);
  });

  codeServerProcesses.set(folder, { port, process: proc });
  console.log(`Spawned code-server for ${folder} on port ${port}`);

  // Wait for code-server to be ready (accepting TCP connections)
  await waitForPort(port, 15000);
  return port;
}

function waitForPort(port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`code-server did not start within ${timeoutMs}ms`));
        return;
      }
      const sock = createConnection({ port, host: 'localhost' });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => { sock.destroy(); setTimeout(attempt, 200); });
    }
    attempt();
  });
}

export function stopCodeServer(folder) {
  const entry = codeServerProcesses.get(folder);
  if (entry) {
    try {
      entry.process.kill('SIGTERM');
    } catch (err) {
      if (err.code !== 'ESRCH') {
        console.warn(`Error stopping code-server for folder "${folder}": ${err.message}`);
      }
    }
    allocatedPorts.delete(entry.port);
    codeServerProcesses.delete(folder);
  }
}

export function getCodeServerPort(folder) {
  const entry = codeServerProcesses.get(folder);
  return entry ? entry.port : null;
}

export function getCodeServerStatus(folder) {
  const entry = codeServerProcesses.get(folder);
  return {
    running: !!entry,
    port: entry ? entry.port : null,
  };
}

export function stopAllCodeServers() {
  for (const [, entry] of codeServerProcesses) {
    try {
      entry.process.kill('SIGTERM');
    } catch (err) {
      if (err.code !== 'ESRCH') {
        console.warn(`Error stopping a code-server process during shutdown: ${err.message}`);
      }
    }
  }
  codeServerProcesses.clear();
  allocatedPorts.clear();
}
