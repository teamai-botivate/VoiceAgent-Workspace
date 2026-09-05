const allowedKeys = new Set([
  'ELEVENLABS_API_KEY',
  'ELLEVENLABS_API_KEY',
  'TURSO_DATABASE_URL',
  'TURSO_DATABASE_TOKEN',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_API_KEY',
  'TWILIO_API_SECRET',
  'TWILIO_PHONE_NUMBER',
]);

const key = process.argv[2];
if (!key || !allowedKeys.has(key)) {
  throw new Error('Pass one supported environment variable name.');
}

const clipboard = spawnSync('wl-paste', ['--no-newline'], { encoding: 'utf8' });

if (clipboard.status !== 0) {
  throw new Error('Could not read the system clipboard.');
}

const value = clipboard.stdout.trim();
if (!value || value.includes('\n') || value.includes('\r')) {
  throw new Error('Clipboard must contain one non-empty line.');
}

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
const source = await readFile(envPath, 'utf8');
const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
const line = `${key}="${escaped}"`;
const pattern = new RegExp(`^${key}=.*$`, 'm');
const updated = pattern.test(source)
  ? source.replace(pattern, line)
  : `${source.trimEnd()}\n${line}\n`;

await writeFile(envPath, updated, { mode: 0o600 });
console.log(`${key} updated (value hidden).`);

import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
