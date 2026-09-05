import { closeDatabase, getDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';

try {
  await runMigrations(getDatabase());
  process.stdout.write('Database migrations completed.\n');
} finally {
  await closeDatabase();
}
