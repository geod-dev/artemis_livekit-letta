import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Migrator, type MigrationFile, type MigrationQuery, migrationChecksum } from './migrator.ts';

/** Records every statement; `applied` seeds schema_migrations; any statement containing FAIL throws. */
function recordingDb(applied: Record<string, string> = {}) {
  const statements: string[] = [];
  const query: MigrationQuery = async (sql, params) => {
    statements.push(sql);
    if (sql.includes('FAIL')) throw new Error('syntax error');
    if (sql.startsWith('SELECT id, checksum FROM schema_migrations')) {
      return { rows: Object.entries(applied).map(([id, checksum]) => ({ id, checksum })) };
    }
    return { rows: [] };
  };
  return { query, statements };
}

const file = (id: string, sql: string): MigrationFile => ({ id, sql });

test('applies unapplied files in name order, each in its own transaction, under an advisory lock', async () => {
  const db = recordingDb();
  const ran = await new Migrator(db.query, async () => [file('0002_next', 'CREATE TABLE b ();'), file('0001_initial', 'CREATE TABLE a ();')]).run();

  assert.deepEqual(ran, ['0001_initial', '0002_next']);
  const statements = db.statements;
  assert.match(statements[0] ?? '', /pg_advisory_lock/);
  assert.match(statements.at(-1) ?? '', /pg_advisory_unlock/);
  const first = statements.indexOf('CREATE TABLE a ();');
  assert.equal(statements[first - 1], 'BEGIN');
  assert.match(statements[first + 1] ?? '', /INSERT INTO schema_migrations/);
  assert.equal(statements[first + 2], 'COMMIT');
  assert.ok(first < statements.indexOf('CREATE TABLE b ();'));
});

test('skips applied files whose checksum still matches', async () => {
  const sql = 'CREATE TABLE a ();';
  const db = recordingDb({ '0001_initial': migrationChecksum(sql) });
  assert.deepEqual(await new Migrator(db.query, async () => [file('0001_initial', sql)]).run(), []);
  assert.equal(db.statements.includes(sql), false);
});

test('a changed applied file is an error, and the lock is still released', async () => {
  const db = recordingDb({ '0001_initial': migrationChecksum('CREATE TABLE old ();') });
  await assert.rejects(
    new Migrator(db.query, async () => [file('0001_initial', 'CREATE TABLE new ();')]).run(),
    (error: unknown) => (error as { code?: string }).code === 'migration_changed'
  );
  assert.match(db.statements.at(-1) ?? '', /pg_advisory_unlock/);
});

test('a failing file is rolled back, rethrown, later files are not applied, and the lock is released', async () => {
  const db = recordingDb();
  await assert.rejects(
    new Migrator(db.query, async () => [file('0001_bad', 'SELECT FAIL;'), file('0002_later', 'CREATE TABLE later ();')]).run(),
    /syntax error/
  );
  assert.ok(db.statements.includes('ROLLBACK'));
  assert.equal(db.statements.includes('CREATE TABLE later ();'), false);
  assert.match(db.statements.at(-1) ?? '', /pg_advisory_unlock/);
});

test('checksums ignore Windows line endings', () => {
  assert.equal(migrationChecksum('CREATE TABLE a ();\r\nSELECT 1;\r\n'), migrationChecksum('CREATE TABLE a ();\nSELECT 1;\n'));
});
