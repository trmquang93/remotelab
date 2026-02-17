#!/usr/bin/env node
import { scryptSync, randomBytes } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('Usage: node hash-password.mjs <username> <password>');
  process.exit(1);
}

const [username, password] = args;

const salt = randomBytes(16).toString('hex');
const hash = scryptSync(password, salt, 64).toString('hex');

const authFile = join(homedir(), '.config', 'claude-web', 'auth.json');
const authDir = dirname(authFile);

mkdirSync(authDir, { recursive: true });

const authData = {
  username,
  hash,
  salt
};

writeFileSync(authFile, JSON.stringify(authData, null, 2), 'utf8');
console.log(`Password hash written to: ${authFile}`);
