import {
  pgTable,
  text,
  boolean,
  timestamp,
  integer,
  numeric,
  jsonb,
  bigint,
  uuid,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

/* ============ better-auth core tables ============ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ============ App tables ============ */

export const profiles = pgTable("profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  handle: text("handle").unique(),
  displayName: text("display_name"),
  bio: text("bio"),
  avatarUrl: text("avatar_url"),
  planId: text("plan_id").notNull().default("free"),
  planRenewsAt: timestamp("plan_renews_at", { withTimezone: true }),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  credits: numeric("credits", { precision: 14, scale: 3 }).notNull().default("0"),
  boostSlots: integer("boost_slots").notNull().default(0),
  autoPublish: boolean("auto_publish").notNull().default(false),
  specialty: text("specialty"),
  studio: text("studio"),
  location: text("location"),
  links: jsonb("links").notNull().default({}), // {instagram,youtube,tiktok,x,discord,website}
  onboarded: boolean("onboarded").notNull().default(false),
  interests: jsonb("interests").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  pooledCredits: boolean("pooled_credits").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // owner | admin | member
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export type LedgerKind =
  | "grant"
  | "signup_bonus"
  | "daily"
  | "daily_grant"
  | "plan_grant"
  | "purchase"
  | "topup"
  | "spend"
  | "refund"
  | "adjustment";

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    delta: numeric("delta", { precision: 14, scale: 3 }).notNull(),
    balanceAfter: numeric("balance_after", { precision: 14, scale: 3 }).notNull(),
    kind: text("kind").notNull(),
    refType: text("ref_type"),
    refId: text("ref_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ledger_user_created_idx").on(t.userId, t.createdAt)],
);

export const jobStatus = [
  "queued",
  "in_progress",
  "completed",
  "failed",
  "nsfw",
  "canceled",
] as const;
export type JobStatus = (typeof jobStatus)[number];

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // image | video | audio | edit | upscale | character | avatar | v2v
    modelId: text("model_id").notNull(),
    endpointId: text("endpoint_id").notNull(),
    workflow: text("workflow").notNull(), // e.g. text-to-video
    title: text("title"),
    prompt: text("prompt"),
    params: jsonb("params").notNull().default({}),
    inputs: jsonb("inputs").notNull().default([]),
    presetId: text("preset_id"),
    presetKind: text("preset_kind"),
    provider: text("provider").notNull(),
    providerRequestId: text("provider_request_id"),
    providerMeta: jsonb("provider_meta").notNull().default({}),
    status: text("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    costCredits: numeric("cost_credits", { precision: 14, scale: 3 }).notNull().default("0"),
    outputs: jsonb("outputs").notNull().default([]),
    error: text("error"),
    idempotencyKey: text("idempotency_key"),
    projectId: uuid("project_id"),
    parentJobId: uuid("parent_job_id"), // remix lineage
    graphJson: jsonb("graph_json"), // Comfy workflow graph snapshot - forkable
    graphForkedFrom: uuid("graph_forked_from"), // workflow-graph lineage (distinct from job lineage)
    visibility: text("visibility").notNull().default("private"), // private | public
    likesCount: integer("likes_count").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_user_created_idx").on(t.userId, t.createdAt),
    index("jobs_status_lease_idx").on(t.status, t.leaseUntil),
    index("jobs_feed_idx").on(t.visibility, t.createdAt),
    uniqueIndex("jobs_idem_idx").on(t.userId, t.idempotencyKey),
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    jobId: uuid("job_id"),
    kind: text("kind").notNull(), // image | video | audio | file
    url: text("url").notNull(),
    mime: text("mime"),
    width: integer("width"),
    height: integer("height"),
    durationSec: numeric("duration_sec", { precision: 10, scale: 3 }),
    bytes: integer("bytes"),
    prompt: text("prompt"),
    endpointId: text("endpoint_id"),
    projectId: uuid("project_id"),
    visibility: text("visibility").notNull().default("private"),
    favorite: boolean("favorite").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("assets_user_idx").on(t.userId, t.createdAt), index("assets_feed_idx").on(t.visibility, t.createdAt)],
);

export const uploads = pgTable(
  "uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("uploads_user_idx").on(t.userId, t.createdAt)],
);

export const characters = pgTable(
  "characters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    modelVersion: text("model_version").notNull().default("v2"),
    status: text("status").notNull().default("queued"), // queued|in_progress|completed|failed
    thumbnailUrl: text("thumbnail_url"),
    inputImages: jsonb("input_images").notNull().default([]),
    providerRefId: text("provider_ref_id"),
    failReason: text("fail_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("characters_user_idx").on(t.userId)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    coverUrl: text("cover_url"),
    visibility: text("visibility").notNull().default("private"), // private | public
    likesCount: integer("likes_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("projects_user_idx").on(t.userId), index("projects_public_idx").on(t.visibility, t.createdAt)],
);

export const projectItems = pgTable(
  "project_items",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.jobId] })],
);

export const likes = pgTable(
  "likes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(), // job | project
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.targetType, t.targetId] })],
);

/** Elements - named reusable references (Character/Location/Prop), invoked via @element in prompts. */
export const elements = pgTable(
  "elements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),           // used as @name
    category: text("category").notNull().default("character"), // character | location | prop
    description: text("description"),
    images: jsonb("images").notNull().default([]), // urls
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("elements_user_idx").on(t.userId), uniqueIndex("elements_user_name_idx").on(t.userId, t.name)],
);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("folders_user_idx").on(t.userId)],
);

export const folderItems = pgTable(
  "folder_items",
  {
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.folderId, t.assetId] })],
);

export const follows = pgTable(
  "follows",
  {
    followerId: text("follower_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    followingId: text("following_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.followerId, t.followingId] })],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(), // asset | job | project
    targetId: uuid("target_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("comments_target_idx").on(t.targetType, t.targetId)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // job_done | job_failed | like | follow | reward | system
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notif_user_idx").on(t.userId, t.createdAt)],
);

export const promocodes = pgTable("promocodes", {
  code: text("code").primaryKey(),
  credits: numeric("credits", { precision: 14, scale: 3 }).notNull().default("0"),
  planId: text("plan_id"),
  maxRedemptions: integer("max_redemptions"),
  redeemed: integer("redeemed").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const promocodeRedemptions = pgTable(
  "promocode_redemptions",
  {
    code: text("code")
      .notNull()
      .references(() => promocodes.code, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.code, t.userId] })],
);

/** Workspace invites (team members by email). */
export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("pending"), // pending | accepted | declined
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invites_ws_idx").on(t.workspaceId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    keyId: text("key_id").notNull().unique(), // public id portion
    secretHash: text("secret_hash").notNull(),
    label: text("label").notNull().default("default"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_keys_user_idx").on(t.userId)],
);

export const rateBuckets = pgTable(
  "rate_buckets",
  {
    key: text("key").primaryKey(), // e.g. "gen:{userId}" or "api:{keyId}"
    tokens: numeric("tokens", { precision: 14, scale: 3 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  title: text("title"),
  status: text("status").notNull().default("active"), // active | awaiting_input | done | interrupted
  projectId: uuid("project_id"),
  context: jsonb("context").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("agent_sessions_user_idx").on(t.userId, t.createdAt)]);

export const agentMessages = pgTable("agent_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  seq: bigint("seq", { mode: "bigint" }).generatedAlwaysAsIdentity(),
  role: text("role").notNull(), // user | assistant | tool | system
  kind: text("kind").notNull().default("text"), // text | plan | tool_call | tool_result | question | status
  content: jsonb("content").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("agent_messages_session_idx").on(t.sessionId, t.seq)]);

export const reEditChains = pgTable("re_edit_chains", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  videoUrl: text("video_url").notNull(),
  flow: text("flow").notNull(), // motion-transfer | object-swap | restyle
  instructions: text("instructions"),
  imageUrls: jsonb("image_urls").notNull().default([]),
  presetId: text("preset_id"),
  shots: jsonb("shots").notNull().default([]), // [{index,start,end,hint?}]
  shotOutputs: jsonb("shot_outputs").notNull().default([]), // [{index,url,job_id}]
  status: text("status").notNull().default("queued"), // queued | running | assembling | completed | failed
  resultUrl: text("result_url"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("re_edit_chains_user_idx").on(t.userId, t.createdAt)]);

export const migrationsMeta = pgTable("_migrations", {
  name: text("name").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});

/* Workstream schema extension points - see db/migrations/README.md */
export * from "./schema/ws1";
export * from "./schema/ws2";
export * from "./schema/ws3";
export * from "./schema/ws4";
export * from "./schema/ws5";
export * from "./schema/ws6";
