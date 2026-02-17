import { homedir } from 'os';
import { join, resolve } from 'path';

export function resolveTilde(path) {
  if (!path) return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(1));
  }
  if (path.startsWith('~')) {
    return join(homedir(), path.slice(1));
  }
  return resolve(path);
}

export function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolvePromise(body));
    req.on('error', reject);
  });
}
