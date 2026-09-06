import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../packages/db/src/schema.js";

export async function createTestDatabase() {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  await migrate(db, {
    migrationsFolder: resolve(
      import.meta.dirname,
      "../../packages/db/migrations",
    ),
  });

  return {
    client,
    db,
    close: () => client.close(),
  };
}

export function id(): string {
  return randomUUID();
}
