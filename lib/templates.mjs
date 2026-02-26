import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(__dirname, '..', 'templates');

export const loginPage = readFileSync(join(templatesDir, 'login.html'), 'utf8');
export const dashboardPage = readFileSync(join(templatesDir, 'dashboard.html'), 'utf8');
export const sessionViewPage = readFileSync(join(templatesDir, 'session-view.html'), 'utf8');
export const folderViewPage = readFileSync(join(templatesDir, 'folder-view.html'), 'utf8');
