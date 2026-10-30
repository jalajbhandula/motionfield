// WS5 schema extension point - additive tables for workstream 5 live here.
import { pgTable, text, timestamp, jsonb, uuid, index, integer, boolean, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { user } from "../schema";

/** SceneSpec v1 documents (see src/lib/render/spec.ts) saved by signed-in users. */
export const renderSpecs = pgTable(
  "render_specs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    spec: jsonb("spec").notNull(),
    /** display name for the Recent list - derived from the prompt */
    title: text("title"),
    /** the generate prompt that produced this spec */
    prompt: text("prompt"),
    /** optional website URL the spec's brand context was fetched from */
    sourceUrl: text("source_url"),
    /** brand context captured at generate time - refine reuses it, no re-fetch */
    brand: jsonb("brand"),
    /** refine lineage - set when the row came from /refine */
    parentId: uuid("parent_id").references((): AnyPgColumn => renderSpecs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("render_specs_user_idx").on(t.userId, t.createdAt)],
);

/**
 * Stage scenes - the grey-box 3D blocking documents the /scene-3d editor writes
 * (see src/lib/stage/scene.ts). `revision` is the optimistic-concurrency
 * counter the editor's autosave carries; `refs` holds the owned upload
 * attachments (and their vision descriptions when a vision route existed at
 * create time).
 */
export const stageScenes = pgTable(
  "stage_scenes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    scene: jsonb("scene").notNull(),
    refs: jsonb("refs").notNull().default([]),
    /** whether the create-time refs were read by a vision route */
    refsRead: boolean("refs_read").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stage_scenes_user_idx").on(t.userId, t.updatedAt)],
);

/**
 * Stage revision history - one snapshot per committed head (migration 0504).
 * source: create|save|prompt|ops|restore. session_id is the editor's per-load
 * id: autosave PUTs carrying it replace that session's latest 'save' row
 * (<10 min old) instead of appending. Pruned to the newest 200 per scene.
 */
export const stageRevisions = pgTable(
  "stage_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sceneId: uuid("scene_id")
      .notNull()
      .references(() => stageScenes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    source: text("source").notNull(), // create | save | prompt | ops | restore
    sessionId: text("session_id"),
    scene: jsonb("scene").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("stage_revisions_rev_idx").on(t.sceneId, t.revision),
    index("stage_revisions_scene_idx").on(t.sceneId, t.createdAt),
  ],
);

/**
 * Idempotency keys for POST /api/stage/:id/ops (migration 0505). The dedup
 * tuple is (user_id, key) - a key never collides across users; scene_id +
 * body_hash detect reuse against a different request. Rows live 24 h.
 */
export const stageOpKeys = pgTable(
  "stage_op_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    sceneId: uuid("scene_id")
      .notNull()
      .references(() => stageScenes.id, { onDelete: "cascade" }),
    bodyHash: text("body_hash").notNull(),
    status: integer("status").notNull(),
    response: jsonb("response").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("stage_op_keys_user_key_idx").on(t.userId, t.key)],
);
