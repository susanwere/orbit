import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://orbit:orbit@localhost:5433/orbit";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const seen = await client.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [file]);
      if (seen.rowCount) {
        console.log(`skip ${file}`);
        continue;
      }
      await client.query(readFileSync(join(migrationsDir, file), "utf8"));
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
      console.log(`applied ${file}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
