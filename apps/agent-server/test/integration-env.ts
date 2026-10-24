/**
 * The Postgres server URL for the integration and e2e suites. Locally a missing URL skips the
 * suites; when `CI` is set a missing URL fails them, so CI can never report them as skipped.
 */
export function integrationDatabaseUrl(suite: string): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  if (url) return url;
  if (process.env.CI) throw new Error(`${suite} needs TEST_DATABASE_URL when CI is set`);
  return undefined;
}
