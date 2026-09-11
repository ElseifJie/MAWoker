import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const userRole = pgEnum("user_role", ["user", "admin"]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);
export const agentStatus = pgEnum("agent_status", [
  "provisioning",
  "active",
  "disabled",
  "failed",
  "deleting",
]);
export const agentKind = pgEnum("agent_kind", ["platform", "personal"]);
export const sessionStatus = pgEnum("session_status", [
  "idle",
  "running",
  "rescheduled",
  "terminated",
]);
export const deletionState = pgEnum("deletion_state", [
  "none",
  "pending",
  "deletion_failed",
  "deleted",
]);
export const uploadStatus = pgEnum("upload_status", [
  "uploading",
  "uploaded",
  "bound",
  "failed",
  "deleting",
]);
export const usageMetricType = pgEnum("usage_metric_type", [
  "input_tokens",
  "output_tokens",
  "runtime_ms",
  "tool_calls",
]);
export const quotaReservationStatus = pgEnum("quota_reservation_status", [
  "active",
  "consumed",
  "released",
]);
export const backgroundJobType = pgEnum("background_job_type", [
  "delete_session",
  "delete_artifact",
  "cleanup_artifact_object",
  "cleanup_upload",
  "reconcile_session",
  "reconcile_personal_agent",
]);
export const backgroundJobStatus = pgEnum("background_job_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
]);
export const auditResult = pgEnum("audit_result", ["succeeded", "failed"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    authSubject: text("auth_subject").notNull().unique(),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    role: userRole("role").default("user").notNull(),
    status: userStatus("status").default("active").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("auth_sessions_user_id_idx").on(table.userId),
    index("auth_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const platformAgents = pgTable(
  "platform_agents",
  {
    id: uuid("id").primaryKey(),
    arkAgentId: text("ark_agent_id").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    modelId: text("model_id").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    arkVersion: text("ark_version").notNull(),
    status: agentStatus("status").default("provisioning").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [index("platform_agents_status_idx").on(table.status)],
);

export const personalAgents = pgTable(
  "personal_agents",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    arkAgentId: text("ark_agent_id").notNull(),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    modelId: text("model_id").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    arkVersion: text("ark_version").notNull(),
    status: agentStatus("status").default("provisioning").notNull(),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [
    unique("personal_agents_owner_id_unique").on(table.ownerUserId, table.id),
    uniqueIndex("personal_agents_owner_ark_agent_id_unique").on(
      table.ownerUserId,
      table.arkAgentId,
    ),
    index("personal_agents_owner_status_idx").on(
      table.ownerUserId,
      table.status,
    ),
  ],
);

export const userDefaultAgents = pgTable("user_default_agents", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  platformAgentId: uuid("platform_agent_id")
    .notNull()
    .references(() => platformAgents.id, { onDelete: "restrict" }),
  assignedBy: uuid("assigned_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  assignedAt: timestamp("assigned_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    arkSessionId: text("ark_session_id").notNull().unique(),
    agentKind: agentKind("agent_kind").notNull(),
    platformAgentId: uuid("platform_agent_id").references(
      () => platformAgents.id,
      { onDelete: "restrict" },
    ),
    personalAgentId: uuid("personal_agent_id"),
    arkAgentId: text("ark_agent_id").notNull(),
    agentName: text("agent_name").default("").notNull(),
    agentVersion: text("agent_version").notNull(),
    environmentId: text("environment_id").notNull(),
    title: text("title").default("").notNull(),
    status: sessionStatus("status").default("idle").notNull(),
    lastErrorCode: text("last_error_code"),
    errorRecoverable: boolean("error_recoverable"),
    messageInFlightCount: integer("message_in_flight_count")
      .default(0)
      .notNull(),
    messageStartPending: boolean("message_start_pending")
      .default(false)
      .notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletionState: deletionState("deletion_state").default("none").notNull(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("sessions_owner_id_unique").on(table.ownerUserId, table.id),
    unique("sessions_owner_ark_session_id_unique").on(
      table.ownerUserId,
      table.arkSessionId,
    ),
    foreignKey({
      name: "sessions_personal_agent_owner_fk",
      columns: [table.ownerUserId, table.personalAgentId],
      foreignColumns: [personalAgents.ownerUserId, personalAgents.id],
    }).onDelete("restrict"),
    check(
      "sessions_exactly_one_agent_check",
      sql`(
        (${table.agentKind} = 'platform' and ${table.platformAgentId} is not null and ${table.personalAgentId} is null)
        or
        (${table.agentKind} = 'personal' and ${table.personalAgentId} is not null and ${table.platformAgentId} is null)
      )`,
    ),
    check(
      "sessions_message_in_flight_nonnegative_check",
      sql`${table.messageInFlightCount} >= 0`,
    ),
    index("sessions_owner_archived_idx").on(
      table.ownerUserId,
      table.archivedAt,
    ),
    index("sessions_owner_status_idx").on(table.ownerUserId, table.status),
  ],
);

export const sessionEventCursors = pgTable("session_event_cursors", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
  runningSince: timestamp("running_since", { withTimezone: true }),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  recentEventIds: jsonb("recent_event_ids")
    .$type<string[]>()
    .default(sql`'[]'::jsonb`)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const sessionInputs = pgTable(
  "session_inputs",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id"),
    arkFileId: text("ark_file_id"),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mountPath: text("mount_path").notNull(),
    status: uploadStatus("status").default("uploading").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "session_inputs_session_owner_fk",
      columns: [table.ownerUserId, table.sessionId],
      foreignColumns: [sessions.ownerUserId, sessions.id],
    }).onDelete("cascade"),
    uniqueIndex("session_inputs_owner_ark_file_id_unique").on(
      table.ownerUserId,
      table.arkFileId,
    ),
    check("session_inputs_size_check", sql`${table.sizeBytes} >= 0`),
    check(
      "session_inputs_bound_check",
      sql`${table.status} <> 'bound' or ${table.sessionId} is not null`,
    ),
    index("session_inputs_owner_session_idx").on(
      table.ownerUserId,
      table.sessionId,
    ),
    index("session_inputs_cleanup_idx").on(table.status, table.expiresAt),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull(),
    arkFileId: text("ark_file_id").notNull(),
    tosObjectKey: text("tos_object_key").notNull().unique(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    deletionState: deletionState("deletion_state").default("none").notNull(),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "artifacts_session_owner_fk",
      columns: [table.ownerUserId, table.sessionId],
      foreignColumns: [sessions.ownerUserId, sessions.id],
    }).onDelete("cascade"),
    uniqueIndex("artifacts_session_ark_file_id_unique").on(
      table.ownerUserId,
      table.sessionId,
      table.arkFileId,
    ),
    check("artifacts_size_check", sql`${table.sizeBytes} >= 0`),
    index("artifacts_owner_session_idx").on(table.ownerUserId, table.sessionId),
  ],
);

export const quotaPolicies = pgTable(
  "quota_policies",
  {
    key: text("key").primaryKey(),
    personalAgentLimit: integer("personal_agent_limit").notNull(),
    concurrentSessionLimit: integer("concurrent_session_limit").notNull(),
    dailySessionLimit: integer("daily_session_limit").notNull(),
    monthlyTokenLimit: bigint("monthly_token_limit", {
      mode: "number",
    }).notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      "quota_policies_nonnegative_check",
      sql`${table.personalAgentLimit} >= 0
          and ${table.concurrentSessionLimit} >= 0
          and ${table.dailySessionLimit} >= 0
          and ${table.monthlyTokenLimit} >= 0`,
    ),
  ],
);

export const userQuotaOverrides = pgTable(
  "user_quota_overrides",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    personalAgentLimit: integer("personal_agent_limit"),
    concurrentSessionLimit: integer("concurrent_session_limit"),
    dailySessionLimit: integer("daily_session_limit"),
    monthlyTokenLimit: bigint("monthly_token_limit", { mode: "number" }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "user_quota_overrides_nonnegative_check",
      sql`coalesce(${table.personalAgentLimit}, 0) >= 0
          and coalesce(${table.concurrentSessionLimit}, 0) >= 0
          and coalesce(${table.dailySessionLimit}, 0) >= 0
          and coalesce(${table.monthlyTokenLimit}, 0) >= 0`,
    ),
  ],
);

export const quotaReservations = pgTable(
  "quota_reservations",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: quotaReservationStatus("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("quota_reservations_active_idx").on(
      table.userId,
      table.status,
      table.expiresAt,
    ),
  ],
);

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    arkSessionId: text("ark_session_id").notNull(),
    arkEventId: text("ark_event_id").notNull(),
    metricType: usageMetricType("metric_type").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "usage_ledger_session_owner_fk",
      columns: [table.userId, table.arkSessionId],
      foreignColumns: [sessions.ownerUserId, sessions.arkSessionId],
    }).onDelete("cascade"),
    uniqueIndex("usage_ledger_event_metric_unique").on(
      table.userId,
      table.arkSessionId,
      table.arkEventId,
      table.metricType,
    ),
    check("usage_ledger_quantity_check", sql`${table.quantity} >= 0`),
    index("usage_ledger_user_recorded_idx").on(table.userId, table.recordedAt),
  ],
);

export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    type: backgroundJobType("type").notNull(),
    status: backgroundJobStatus("status").default("pending").notNull(),
    priority: integer("priority").default(100).notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(10).notNull(),
    runAfter: timestamp("run_after", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [
    check(
      "background_jobs_attempts_check",
      sql`${table.attempts} >= 0 and ${table.maxAttempts} > 0`,
    ),
    index("background_jobs_claim_idx").on(
      table.status,
      table.runAfter,
      table.priority,
    ),
  ],
);

export const quotaInterruptJobs = pgTable(
  "quota_interrupt_jobs",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull(),
    monthStart: timestamp("month_start", { withTimezone: true }).notNull(),
    status: backgroundJobStatus("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(10).notNull(),
    runAfter: timestamp("run_after", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "quota_interrupt_jobs_session_owner_fk",
      columns: [table.userId, table.sessionId],
      foreignColumns: [sessions.ownerUserId, sessions.id],
    }).onDelete("cascade"),
    uniqueIndex("quota_interrupt_jobs_user_session_month_unique").on(
      table.userId,
      table.sessionId,
      table.monthStart,
    ),
    check(
      "quota_interrupt_jobs_attempts_check",
      sql`${table.attempts} >= 0 and ${table.maxAttempts} > 0`,
    ),
    index("quota_interrupt_jobs_claim_idx").on(table.status, table.runAfter),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    result: auditResult("result").notNull(),
    requestId: text("request_id").notNull(),
    arkRequestId: text("ark_request_id"),
    errorCode: text("error_code"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_logs_actor_created_idx").on(
      table.actorUserId,
      table.createdAt,
    ),
    index("audit_logs_request_id_idx").on(table.requestId),
  ],
);
