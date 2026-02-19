#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

const [,, command, ...args] = process.argv;

function scriptPath(name) {
  return path.join(__dirname, name);
}

function runShell(script) {
  try {
    execFileSync('bash', [scriptPath(script)], { stdio: 'inherit' });
  } catch (err) {
    process.exit(err.status ?? 1);
  }
}

function printHelp() {
  console.log(`remotelab v${pkg.version}

Usage:
  remotelab setup                    Run interactive setup
  remotelab start                    Start auth proxy + ttyd
  remotelab stop                     Stop all services
  remotelab server                   Run auth proxy in foreground
  remotelab hash-password <user> <pass>  Hash a password for config
  remotelab --help                   Show this help message
  remotelab --version                Show version`);
}

switch (command) {
  case 'setup':
    runShell('setup.sh');
    break;

  case 'start':
    runShell('start.sh');
    break;

  case 'stop':
    runShell('stop.sh');
    break;

  case 'server':
    await import(scriptPath('auth-proxy.mjs'));
    break;

  case 'hash-password': {
    try {
      execFileSync('node', [scriptPath('hash-password.mjs'), ...args], { stdio: 'inherit' });
    } catch (err) {
      process.exit(err.status ?? 1);
    }
    break;
  }

  case '--version':
  case '-v':
    console.log(pkg.version);
    break;

  case '--help':
  case '-h':
  case undefined:
    printHelp();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "remotelab --help" for usage.');
    process.exit(1);
}
