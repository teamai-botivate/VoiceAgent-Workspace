import { type Client, createClient } from '@libsql/client';
import { createClient as createRemoteClient } from '@tursodatabase/serverless/compat';
import { env, requireConfig } from '../config/env.js';

let client: Client | undefined;

export function getDatabase(): Client {
  if (!client) {
    const url = requireConfig('TURSO_DATABASE_URL');
    const authToken = env.TURSO_AUTH_TOKEN;
    if (!url.startsWith('file:') && !authToken) {
      throw new Error('Missing required configuration: TURSO_AUTH_TOKEN');
    }
    client = url.startsWith('file:')
      ? createClient({ url })
      : (createRemoteClient({
          url,
          authToken: authToken as string,
        }) as unknown as Client);
  }
  return client;
}

export async function closeDatabase(): Promise<void> {
  client?.close();
  client = undefined;
}

export async function checkDatabase(): Promise<void> {
  await getDatabase().execute('SELECT 1 AS ready');
}

// Remote Turso connections default to `foreign_keys = 0`, which leaves every REFERENCES
// clause in the schema unenforced at runtime. Local file databases already default to
// ON, so tests have always run with enforcement; this brings the serving path in line.
export async function enableForeignKeys(client: Client): Promise<void> {
  await client.execute('PRAGMA foreign_keys = ON');
}
