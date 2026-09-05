import { closeDatabase, getDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { seedDemoData } from '../src/db/seed.js';

try {
  const database = getDatabase();
  await runMigrations(database);
  await seedDemoData(database);
  process.stdout.write('Standalone fictional demo data seeded.\n');
} finally {
  await closeDatabase();
}
