// Postgres on-ramp: migrations live in ../migrations and are applied by
// src/migrate.ts. Seed data is not duplicated here — the canonical demo
// seed currently lives in apps/api/src/store.ts; when the API is wired to
// Postgres, the seed moves here as the single source.
export {};
