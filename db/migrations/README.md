# Migrations

`scripts/migrate.ts` applies `*.sql` files in this directory in filename order,
tracked by name in the `_migrations` table. Migrations are **additive only** —
always use `IF NOT EXISTS` (tables, indexes) and never drop or rewrite existing
objects.

## Filename ranges

Each parallel workstream owns a range; never use another workstream's numbers.

| Range       | Workstream |
| ----------- | ---------- |
| 0000–0099   | foundation (already applied) |
| 0100–0199   | WS1        |
| 0200–0299   | WS2        |
| 0300–0399   | WS3        |
| 0400–0499   | WS4        |
| 0500–0599   | WS5        |
| 0600–0699   | Extras (games, dub, persona builder, relight) |

Matching Drizzle schema tables go in `src/db/schema/wsN.ts` (already re-exported
from `src/db/schema.ts`).
