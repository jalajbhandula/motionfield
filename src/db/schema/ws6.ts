// Extras schema - additive tables for the extra studios (games, …).
import { pgTable, text, timestamp, jsonb, uuid, index, boolean } from "drizzle-orm/pg-core";
import { user } from "../schema";

/** GameSpec v1 documents (see src/lib/games/spec.ts). `via` records whether a
 *  local model designed the game ("llm") or the keyword template did. */
export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    spec: jsonb("spec").notNull(),
    via: text("via").notNull(),
    isPublic: boolean("is_public").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("games_user_idx").on(t.userId, t.updatedAt)],
);
