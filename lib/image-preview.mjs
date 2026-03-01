import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = `node ${join(__dirname, 'hooks', 'on-image-read.mjs')}`;

// ---------------------------------------------------------------------------
// SSE client manager: folder -> Set<res>
// ---------------------------------------------------------------------------
const clients = new Map();

export function addClient(folder, res) {
  if (!clients.has(folder)) clients.set(folder, new Set());
  clients.get(folder).add(res);
}

export function removeClient(folder, res) {
  const set = clients.get(folder);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(folder);
}

export function broadcast(folder, data) {
  const set = clients.get(folder);
  if (!set) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    res.write(payload);
  }
}

// ---------------------------------------------------------------------------
// In-memory latest image event store: folder -> { filePath, timestamp }
// ---------------------------------------------------------------------------
const latestImageEvent = new Map();

export function recordImageEvent(folder, filePath) {
  const event = { filePath, timestamp: Date.now() };
  latestImageEvent.set(folder, event);
  broadcast(folder, event);
}

export function getLatestImageEvent(folder) {
  return latestImageEvent.get(folder) || null;
}

// ---------------------------------------------------------------------------
// Hook configuration helpers
// ---------------------------------------------------------------------------

function settingsPath(folderPath) {
  return join(folderPath, '.claude', 'settings.json');
}

function makeHookEntry() {
  return {
    matcher: 'Read',
    hooks: [
      {
        type: 'command',
        command: HOOK_SCRIPT,
        async: true,
        timeout: 10,
      },
    ],
  };
}

function isOurHook(entry) {
  return (
    entry.matcher === 'Read' &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => h.command === HOOK_SCRIPT)
  );
}

async function readSettings(folderPath) {
  try {
    const raw = await readFile(settingsPath(folderPath), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeSettings(folderPath, settings) {
  const filePath = settingsPath(folderPath);
  if (Object.keys(settings).length === 0) {
    // Remove file if empty — use unlink but don't fail if missing
    const { unlink } = await import('fs/promises');
    try { await unlink(filePath); } catch { /* ignore */ }
    return;
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(settings, null, 2) + '\n');
}

export async function configureHook(folderPath, enable) {
  const settings = await readSettings(folderPath);

  if (enable) {
    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];

    const already = settings.hooks.PostToolUse.some(isOurHook);
    if (!already) {
      settings.hooks.PostToolUse.push(makeHookEntry());
    }

    await writeSettings(folderPath, settings);
  } else {
    // Disable: remove our hook entry
    const postToolUse = settings.hooks?.PostToolUse;
    if (!Array.isArray(postToolUse)) return;

    settings.hooks.PostToolUse = postToolUse.filter((e) => !isOurHook(e));

    if (settings.hooks.PostToolUse.length === 0) delete settings.hooks.PostToolUse;
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

    await writeSettings(folderPath, settings);
  }
}

export async function isHookConfigured(folderPath) {
  const settings = await readSettings(folderPath);
  const postToolUse = settings.hooks?.PostToolUse;
  if (!Array.isArray(postToolUse)) return false;
  return postToolUse.some(isOurHook);
}
