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
const port = Number(process.argv[3] ?? '47831');
if (!key || !allowedKeys.has(key) || !Number.isInteger(port)) {
  throw new Error('Pass a supported environment variable and a valid port.');
}

const envPath = fileURLToPath(new URL('../.env', import.meta.url));

async function save(value: string) {
  if (!value || value.includes('\n') || value.includes('\r')) {
    throw new Error('Secret must contain one non-empty line.');
  }

  const source = await readFile(envPath, 'utf8');
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const line = `${key}="${escaped}"`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const updated = pattern.test(source)
    ? source.replace(pattern, line)
    : `${source.trimEnd()}\n${line}\n`;
  await writeFile(envPath, updated, { mode: 0o600 });
}

const server = createServer((request, response) => {
  response.setHeader('cache-control', 'no-store');
  if (request.method === 'GET') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      '<!doctype html><html><body><form method="post"><label for="secret">Credential</label><input id="secret" name="secret" type="password" autocomplete="off"><button type="submit">Save locally</button></form></body></html>',
    );
    return;
  }

  if (request.method !== 'POST') {
    response.statusCode = 405;
    response.end('Method not allowed.');
    return;
  }

  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', async () => {
    try {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      await save((form.get('secret') ?? '').trim());
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end(`${key} saved locally; value hidden.`);
      setTimeout(() => server.close(), 100);
    } catch {
      response.statusCode = 400;
      response.end('Invalid credential.');
    }
  });
});

server.listen(port, '127.0.0.1');

console.log(`Ready to receive ${key} on http://127.0.0.1:${port}`);

import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
