// WS1 schema extension point - additive columns for workstream 1.
// These mirror the ALTER TABLE columns added by db/migrations/0100_api_keys.sql
// so code can reach them with typed Drizzle accessors. The base tables remain
// owned by src/db/schema.ts (frozen); only the WS1-added columns are declared
// here alongside the key columns needed to address rows.
import { pgTable, text, integer, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";

/** api_keys columns added/owned by WS1 (see migration 0100). */
export const apiKeysWs1 = pgTable("api_keys", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull(),
  keyId: text("key_id").notNull(),
  secretHash: text("secret_hash").notNull(),
  label: text("label").notNull().default("default"),
  maxConcurrency: integer("max_concurrency").notNull().default(2),
  webhookSecret: text("webhook_secret"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/** jobs WS1 columns (api_key_id, request_hash - migration 0100) are written via
 *  the raw-SQL INSERT in createJobEx. `source` (migration 0102) is mirrored
 *  here so v1 list/detail reads can select it with a typed accessor. */
export const jobsWs1 = pgTable("jobs", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** ui | api | cli | mcp | agent - CHECK jobs_source_check */
  source: text("source").notNull().default("ui"),
});

/** assets `source` (migration 0102) - inherited from the producing job at
 *  finalize; uploads/assets written directly carry the caller's tag. */
export const assetsWs1 = pgTable("assets", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull(),
  jobId: uuid("job_id"),
  source: text("source").notNull().default("ui"),
});

/** uploads `source` (migration 0102). */
export const uploadsWs1 = pgTable("uploads", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull(),
  source: text("source").notNull().default("ui"),
});

/** webhook_deliveries - migration 0101. One row per job per terminal event. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull(),
    apiKeyId: uuid("api_key_id"),
    type: text("type").notNull(), // job.completed | job.failed | job.nsfw | job.canceled
    url: text("url").notNull(),
    /** frozen JSON body - retries resend these exact bytes */
    body: text("body").notNull(),
    /** pending | delivering | delivered | failed | exhausted */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  // Declared so drizzle-kit/drzl introspection sees them; created by 0101.
  (t) => [
    uniqueIndex("webhook_deliveries_job_type_idx").on(t.jobId, t.type),
    index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt),
  ],
);
