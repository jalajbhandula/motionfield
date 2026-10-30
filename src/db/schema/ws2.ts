// WS2 "Brain" - LLM layer tables (see db/migrations/0200_llm.sql).
// The `user`/`projects` imports are referenced lazily inside .references()
// callbacks, so the schema.ts <-> schema/ws2.ts cycle is safe at module-eval
// time.
import { bigint, bigserial, boolean, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentSessions, projects, user } from "../schema";

/** Per-user provider settings - API keys live AES-256-GCM-encrypted in api_key_enc. */
export const llmProviderSettings = pgTable(
  "llm_provider_settings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    baseUrl: text("base_url"),
    apiKeyEnc: text("api_key_enc"),
    /** Optional wire override (openai-chat | ollama) - mainly for the
     *  Custom provider. */
    wire: text("wire"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.providerId] })],
);

/** Per-user task routes: planner | writer | vision | coder | enhancer | judge. */
export const llmTaskRoutes = pgTable(
  "llm_task_routes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    task: text("task").notNull(),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    wire: text("wire"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.task] })],
);

/** Per-user LLM preferences - the persisted Offline toggle (s3) and the
 *  user-owned SearXNG base URL behind the web_search agent tool (s12). */
export const llmUserPrefs = pgTable("llm_user_prefs", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  offline: boolean("offline").notNull().default(false),
  /** user's own SearXNG instance (external AGPL service, never bundled) -
   *  null disables web_search entirely */
  searxngUrl: text("searxng_url"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------- s4: run engine (0202) ------------------------ */

/** A durable run: validated plan + estimate/ETA + approval gate state. */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: "cascade" }),
    projectId: uuid("project_id"),
    mode: text("mode").notNull().default("auto"),
    /** planning | awaiting_approval | running | paused | done | failed | stopped */
    status: text("status").notNull().default("planning"),
    /** The validated Plan {title, steps[]} the estimate was computed from. */
    plan: jsonb("plan").notNull().default({}),
    estimateCredits: numeric("estimate_credits", { precision: 14, scale: 3 }).notNull().default("0"),
    /** null = unknown (not enough endpoint history to say) */
    etaSeconds: integer("eta_seconds"),
    askFirst: boolean("ask_first").notNull().default(false),
    /** planner route that produced the plan ("ollama·qwen3…" | "built-in planner") */
    via: text("via"),
    /** planner fallback/error note recorded at submit - null when clean */
    plannerNote: text("planner_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_runs_user_idx").on(t.userId, t.createdAt),
    index("agent_runs_session_idx").on(t.sessionId),
    index("agent_runs_status_idx").on(t.status),
  ],
);

/** One ordered step of a run - becomes a real job only at submit time. */
export const runSteps = pgTable(
  "run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    /** The plan step's own id - depends_on and $step refs point at this. */
    stepId: text("step_id").notNull(),
    title: text("title").notNull(),
    endpointId: text("endpoint_id").notNull(),
    /** Declared params - may carry "$step:<id>.outputs[<n>]" refs until submit. */
    params: jsonb("params").notNull().default({}),
    dependsOn: text("depends_on").array().notNull().default([]),
    /** sha256(endpoint + resolved params + upstream output hashes) - set at submit. */
    inputHash: text("input_hash"),
    jobId: uuid("job_id"),
    /** pending | running | done | failed | skipped | canceled */
    status: text("status").notNull().default("pending"),
    outputs: jsonb("outputs").notNull().default([]),
    error: text("error"),
    /** spec revision - bumped by every editStep; prior specs in run_step_revisions */
    rev: integer("rev").notNull().default(0),
    /** Custom mode: endpoint the user explicitly picked (null = planner's choice) */
    modelChoice: text("model_choice"),
    /** Custom mode: effort applied ('draft' | 'standard' | 'high') - provenance */
    effort: text("effort"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("run_steps_run_step_idx").on(t.runId, t.stepId),
    uniqueIndex("run_steps_run_idx_idx").on(t.runId, t.idx),
    index("run_steps_run_idx").on(t.runId, t.idx),
    index("run_steps_status_idx").on(t.status),
  ],
);

/* ------------------------- s5: revisions + events (0203) ---------------- */

/** Step-spec snapshot each time editStep supersedes a spec - the audit feed
 *  behind "earlier versions". Keyed (run_step_id, rev). */
export const runStepRevisions = pgTable(
  "run_step_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    runStepId: uuid("run_step_id").notNull().references(() => runSteps.id, { onDelete: "cascade" }),
    /** the step's plan id at snapshot time */
    stepId: text("step_id").notNull(),
    /** the rev this spec ran under */
    rev: integer("rev").notNull(),
    title: text("title").notNull(),
    endpointId: text("endpoint_id").notNull(),
    params: jsonb("params").notNull().default({}),
    dependsOn: text("depends_on").array().notNull().default([]),
    /** input hash computed under this spec */
    inputHash: text("input_hash"),
    /** job submitted under this spec (if any) */
    jobId: uuid("job_id"),
    /** the step status when superseded */
    status: text("status").notNull(),
    outputs: jsonb("outputs").notNull().default([]),
    error: text("error"),
    /** non-null when an edit superseded under a different step_id */
    replacedByStepId: text("replaced_by_step_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("run_step_revisions_rev_idx").on(t.runStepId, t.rev),
    index("run_step_revisions_step_idx").on(t.runStepId, t.rev),
    index("run_step_revisions_run_idx").on(t.runId),
  ],
);

/** Append-only run event feed - the durable audit behind GET /runs/:id/events
 *  (SSE) and the task tree. seq is global monotonic; per-run order = seq. */
export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    /** denormalized for owner-scoped reads */
    userId: text("user_id").notNull(),
    seq: bigserial("seq", { mode: "bigint" }),
    kind: text("kind").notNull(),
    /** run_steps.step_id when the event is step-scoped */
    stepId: text("step_id"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("run_events_run_idx").on(t.runId, t.seq),
    index("run_events_user_idx").on(t.userId, t.createdAt),
  ],
);

/* ------------------- s8: memory map + project side tables (0206) --------- */

/** A named, user-scoped memory - durable context (a fact, style note, or
 *  saved text) the planner may quote into later turns, always DATA-framed.
 *  projectId null = user-wide; set = only sessions/runs bound to that
 *  project retrieve it. */
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("note"), // note | style | fact | asset
    content: text("content").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("memories_user_name_idx").on(t.userId, t.name),
    index("memories_user_idx").on(t.userId, t.updatedAt),
    index("memories_project_idx").on(t.projectId),
  ],
);

/** A memory's pointer at the caller's own job | upload | ref - verified at
 *  write time, hard-deleted with the memory (forget cascades). */
export const memoryLinks = pgTable(
  "memory_links",
  {
    memoryId: uuid("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.memoryId, t.targetType, t.targetId] }),
    index("memory_links_target_idx").on(t.targetType, t.targetId),
  ],
);

/** Per-project settings the project page edits - planner instructions first.
 *  Side table: the frozen projects columns stay untouched. */
export const projectSettings = pgTable("project_settings", {
  projectId: uuid("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
  instructions: text("instructions").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A named grouping inside a project page. */
export const projectFolders = pgTable(
  "project_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_folders_name_idx").on(t.projectId, t.name),
    index("project_folders_project_idx").on(t.projectId),
  ],
);

/** A pinned target inside a project - its own jobs/assets or an upload the
 *  owner attached in a project session. folder_id files the pin under a
 *  project folder (null = unfiled); deleting the folder unfiles, never unpins. */
export const projectFavs = pgTable(
  "project_favs",
  {
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(), // job | upload | asset
    targetId: uuid("target_id").notNull(),
    folderId: uuid("folder_id").references(() => projectFolders.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.targetType, t.targetId] }),
    index("project_favs_folder_idx").on(t.folderId),
  ],
);

/* ------------------- s3c: HF hub download records (0208) ------------------ */

/** A Hugging Face hub download/pull - weights into ComfyUI models/<subfolder>
 *  or a GGUF through Ollama. Live progress sits in the globalThis registry;
 *  this row is the durable record (pinned revision, verified checksum, the
 *  licence id/class the server classified - never a client-sent one). */
export const hubDownloads = pgTable(
  "hub_downloads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // weights | gguf
    repo: text("repo").notNull(),
    revision: text("revision").notNull(),
    file: text("file").notNull(),
    subfolder: text("subfolder"), // ComfyUI models/ dir; null = ollama pull
    sha256: text("sha256"),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    licenceId: text("licence_id").notNull().default(""),
    licenceClass: text("licence_class").notNull().default(""),
    status: text("status").notNull().default("running"), // running | done | failed | canceled
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("hub_downloads_user_idx").on(t.userId, t.createdAt)],
);
