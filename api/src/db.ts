import { Pool } from "pg";

/**
 * Shared PostgreSQL connection pool. Configuration is taken from the standard
 * libpq environment variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT)
 * or a single DATABASE_URL, both of which are set in docker-compose.
 */
export const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST ?? "db",
        port: Number(process.env.PGPORT ?? 5432),
        user: process.env.PGUSER ?? "asm",
        password: process.env.PGPASSWORD ?? "asm",
        database: process.env.PGDATABASE ?? "asmresource",
      },
);

/** Wait until the database accepts connections (the db container may still be
 *  starting up when the API boots). Retries with a fixed backoff. */
export async function waitForDb(retries = 30, delayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[db] not ready (attempt ${attempt}/${retries}): ${msg}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("Database did not become available in time.");
}
