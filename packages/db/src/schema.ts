import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
export const skillStatus = pgEnum("skill_status", [
  "provisioning",
  "active",
  "failed",
  "deleting",
]);
export const sessionStatus = pgEnum("session_status", [
  "idle",
  "running",
  "rescheduled",
  "terminated",
  "initializing",
  "upgrading",
  "failed",
]);
export const runTriggerKind = pgEnum("run_trigger_kind", [
  "manual",
  "automation",
]);
export const runStatus = pgEnum("run_status", [
  "queued",
  "starting",
  "running",
  "waiting_user",
  "waiting_device",
  "completed",
  "failed",
  "canceled",
  "unknown",
]);
export const configSnapshotState = pgEnum("config_snapshot_state", [
  "unverified",
  "verified",
  "incomplete",
  "mismatch",
]);
/**
 * How trustworthy a ledger row's model attribution is. New online postings
 * carry the Session's create-time verified snapshot as `exact`; rows without
 * a verifiable snapshot (including everything predating this column and
 * post-deletion re-accounting) are `unknown`. `approximate` is reserved for
 * the historical backfill task and is never written by new flows.
 */
export const modelAttributionPrecision = pgEnum("model_attribution_precision", [
  "exact",
  "approximate",
  "unknown",
]);
/**
 * Pre-deletion usage settlement: `pending` until a verification pass proves
 * the history is complete (`confirmed`); `unknown` when completeness cannot
 * be proven. Only `confirmed` unlocks the irreversible delete steps.
 */
export const settlementState = pgEnum("settlement_state", [
  "pending",
  "confirmed",
  "unknown",
]);
export const deletionState = pgEnum("deletion_state", [
  "none",
  "pending",
  "deletion_failed",
  "deleted",
]);
/**
 * What put a byte object into a user's drive. Distinguishes Agent output from
 * user uploads and future imports, both for filtering and for TOS lifecycle
 * rules keyed on the object-path segment.
 */
export const fileOrigin = pgEnum("file_origin", [
  "upload",
  "artifact",
  "import",
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
  "unknown_outcome",
  "consumed",
  "released",
]);
export const quotaMode = pgEnum("quota_mode", ["enforced", "unlimited"]);
export const mcpServerStatus = pgEnum("mcp_server_status", [
  "active",
  "disabled",
]);
export const automationKind = pgEnum("automation_kind", [
  "reminder",
  "execute",
]);
export const automationStatus = pgEnum("automation_status", [
  "active",
  "paused",
  "deleted",
]);
export const automationOccurrenceStatus = pgEnum(
  "automation_occurrence_status",
  ["pending", "claimed", "completed", "failed", "canceled"],
);
export const backgroundJobType = pgEnum("background_job_type", [
  "delete_session",
  "delete_artifact",
  "cleanup_artifact_object",
  /**
   * Supersedes `cleanup_artifact_object`: the payload names a `drive_files` row
   * by id and the server resolves its object key, so no key is attacker-supplied
   * and no path prefix has to be trusted. `cleanup_artifact_object` is retained
   * only to drain jobs created before the drive layer landed.
   */
  "cleanup_drive_object",
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
    /** Credential version; bumped with every admin-level session revocation. */
    authEpoch: integer("auth_epoch").default(0).notNull(),
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
    /** The user's authEpoch at issue time; a mismatch kills the session. */
    issuedEpoch: integer("issued_epoch").default(0).notNull(),
  },
  (table) => [
    index("auth_sessions_user_id_idx").on(table.userId),
    index("auth_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * Invite-only onboarding. Only the SHA-256 of the one-time code is stored; the
 * plaintext is returned once when the administrator creates the invite.
 */
export const inviteCodes = pgTable(
  "invite_codes",
  {
    id: uuid("id").primaryKey(),
    codeHash: text("code_hash").notNull().unique(),
    email: text("email").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    usedByUserId: uuid("used_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("invite_codes_email_idx").on(table.email),
    index("invite_codes_expires_idx").on(table.expiresAt),
  ],
);

export const userMemoryStores = pgTable("user_memory_stores", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "restrict" }),
  fixedStoreId: text("fixed_store_id").unique(),
  state: jsonb("state").notNull(),
  revision: integer("revision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

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
    /**
     * Marks the one Agent per user that the platform owns on their behalf: it
     * is provisioned from the platform default Agent the first time the user
     * uploads a Skill and is kept bound to every Skill they own.
     */
    isAutoDefault: boolean("is_auto_default").default(false).notNull(),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [
    unique("personal_agents_owner_id_unique").on(table.ownerUserId, table.id),
    uniqueIndex("personal_agents_owner_ark_agent_id_unique").on(
      table.ownerUserId,
      table.arkAgentId,
    ),
    uniqueIndex("personal_agents_owner_auto_default_unique")
      .on(table.ownerUserId)
      .where(sql`${table.isAutoDefault}`),
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

/**
 * One default assistant per account. The runtime Agent stays in
 * `personal_agents` (the auto-default row); this profile owns the editable
 * identity, preferences, and an optimistic-concurrency revision.
 */
export const assistantProfiles = pgTable("assistant_profiles", {
  ownerUserId: uuid("owner_user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  defaultAgentId: uuid("default_agent_id").references(() => personalAgents.id, {
    onDelete: "set null",
  }),
  displayName: text("display_name").default("").notNull(),
  persona: text("persona").default("").notNull(),
  preferences: jsonb("preferences")
    .$type<Record<string, unknown>>()
    .default(sql`'{}'::jsonb`)
    .notNull(),
  revision: integer("revision").default(1).notNull(),
  ...timestamps,
});

/**
 * A Skill package uploaded to Ark. A row with `ownerUserId` is a user's custom
 * Skill; `ownerUserId` null marks a platform preset Skill. The bytes live in
 * Ark (there is no Ark delete or update Skill API yet), so "editing" a Skill
 * re-uploads a fresh package and swaps the upstream identity on the same row,
 * and deleting a row only unbinds it locally.
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    arkSkillId: text("ark_skill_id").notNull().unique(),
    /** The Skill name Ark parsed out of the package's SKILL.md. */
    name: text("name").default("").notNull(),
    displayTitle: text("display_title").notNull(),
    description: text("description").default("").notNull(),
    latestVersion: text("latest_version").default("1").notNull(),
    source: text("source").default("custom").notNull(),
    fileName: text("file_name").default("").notNull(),
    fileSize: bigint("file_size", { mode: "number" }).default(0).notNull(),
    status: skillStatus("status").default("provisioning").notNull(),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [
    check("skills_file_size_check", sql`${table.fileSize} >= 0`),
    index("skills_owner_status_idx").on(table.ownerUserId, table.status),
    index("skills_owner_created_idx").on(table.ownerUserId, table.createdAt),
    /**
     * Storage identity is (skill name, owner): the same package name uploaded
     * by two users is two independent rows, and a user can hold one active
     * row per name. Empty names (unparseable packages) are exempt.
     */
    uniqueIndex("skills_owner_name_active_unique")
      .on(table.ownerUserId, table.name)
      .where(sql`${table.status} = 'active' and ${table.name} <> ''`),
    uniqueIndex("skills_preset_name_active_unique")
      .on(table.name)
      .where(
        sql`${table.ownerUserId} is null and ${table.status} = 'active' and ${table.name} <> ''`,
      ),
  ],
);

/**
 * Which Skills a personal Agent was created/updated with. The binding is a
 * snapshot pushed to Ark as `skills: [{skill_id, version}]`; rows are rewritten
 * on every Skill or Agent change that rebinds the Agent.
 */
export const personalAgentSkills = pgTable(
  "personal_agent_skills",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => personalAgents.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    arkSkillId: text("ark_skill_id").notNull(),
    arkVersion: text("ark_version").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.skillId] }),
    index("personal_agent_skills_skill_idx").on(table.skillId),
  ],
);

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
    createAttemptedAt: timestamp("create_attempted_at", {
      withTimezone: true,
    }),
    modelId: text("model_id"),
    configSnapshot: jsonb("config_snapshot").$type<Record<string, unknown>>(),
    configSnapshotState: configSnapshotState("config_snapshot_state")
      .default("unverified")
      .notNull(),
    configSnapshotErrorCode: text("config_snapshot_error_code"),
    memoryStoreId: text("memory_store_id"),
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
    messageUnknownOutcome: boolean("message_unknown_outcome")
      .default(false)
      .notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    deletionState: deletionState("deletion_state").default("none").notNull(),
    settlementState: settlementState("settlement_state")
      .default("pending")
      .notNull(),
    settlementCheckedAt: timestamp("settlement_checked_at", {
      withTimezone: true,
    }),
    /** Verification basis: counters, booleans and reason codes only. */
    settlementEvidence: jsonb("settlement_evidence").$type<
      Record<string, unknown>
    >(),
    deliveryCheckedAt: timestamp("delivery_checked_at", { withTimezone: true }),
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
  /**
   * Set once the full Ark history has been copied into `session_events`. Until
   * then the read path cannot trust the local log to be complete.
   */
  historyBackfilledAt: timestamp("history_backfilled_at", {
    withTimezone: true,
  }),
  historyScanGeneration: integer("history_scan_generation")
    .default(0)
    .notNull(),
  historyRepairRequired: boolean("history_repair_required")
    .default(true)
    .notNull(),
  historyScannedAt: timestamp("history_scanned_at", { withTimezone: true }),
  persistedSequence: bigint("persisted_sequence", { mode: "bigint" })
    .default(sql`0`)
    .notNull(),
  historyAttemptedAt: timestamp("history_attempted_at", { withTimezone: true }),
  historyNextAttemptAt: timestamp("history_next_attempt_at", {
    withTimezone: true,
  }),
  historyFailureCount: integer("history_failure_count").default(0).notNull(),
  recentEventIds: jsonb("recent_event_ids")
    .$type<string[]>()
    .default(sql`'[]'::jsonb`)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * The projected UI events for a Session, kept so reopening a Session is a
 * database read instead of a full replay from Ark. Ark stays authoritative: the
 * log is only ever a cache of events already observed, and rows are written
 * with `on conflict do nothing` so a replay cannot duplicate them.
 */
export const sessionEvents = pgTable(
  "session_events",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    localSequence: bigserial("local_sequence", { mode: "bigint" }).notNull(),
    historyPosition: bigint("history_position", { mode: "number" }),
    sourceType: text("source_type").notNull(),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.eventId] }),
    uniqueIndex("session_events_session_sequence_idx").on(
      table.sessionId,
      table.localSequence,
    ),
    index("session_events_session_occurred_idx").on(
      table.sessionId,
      table.occurredAt,
      table.eventId,
    ),
  ],
);

export const sessionTurns = pgTable(
  "session_turns",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    sessionId: uuid("session_id").notNull(),
    boundaryEventId: text("boundary_event_id").notNull(),
    inputEventId: text("input_event_id").notNull(),
    outcome: text("outcome").notNull(),
    summary: text("summary").default("").notNull(),
    expectedNames: jsonb("expected_names")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    artifactState: text("artifact_state").default("pending").notNull(),
    artifactIds: jsonb("artifact_ids")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    usageState: text("usage_state").default("pending").notNull(),
    errorCode: text("error_code"),
    retryUntil: timestamp("retry_until", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    unique("session_turns_boundary_key").on(
      table.ownerUserId,
      table.sessionId,
      table.boundaryEventId,
    ),
    unique("session_turns_owner_id_key").on(
      table.ownerUserId,
      table.sessionId,
      table.id,
    ),
    foreignKey({
      name: "session_turns_owner_session_fk",
      columns: [table.ownerUserId, table.sessionId],
      foreignColumns: [sessions.ownerUserId, sessions.id],
    }).onDelete("cascade"),
    check(
      "session_turns_outcome_check",
      sql`${table.outcome} in ('completed','waiting','failed','confirming')`,
    ),
    check(
      "session_turns_artifact_state_check",
      sql`${table.artifactState} in ('none','pending','syncing','synced','failed')`,
    ),
    check(
      "session_turns_usage_state_check",
      sql`${table.usageState} in ('pending','complete')`,
    ),
    index("session_turns_owner_session_ended_idx").on(
      table.ownerUserId,
      table.sessionId,
      table.endedAt,
    ),
  ],
);

export const userNotifications = pgTable(
  "user_notifications",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id").notNull(),
    sessionId: uuid("session_id"),
    turnId: uuid("turn_id"),
    sourceType: text("source_type").default("turn").notNull(),
    sourceId: text("source_id"),
    dedupeKey: text("dedupe_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    kind: text("kind").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "user_notifications_owned_turn_fk",
      columns: [table.ownerUserId, table.sessionId, table.turnId],
      foreignColumns: [
        sessionTurns.ownerUserId,
        sessionTurns.sessionId,
        sessionTurns.id,
      ],
    }).onDelete("cascade"),
    unique("user_notifications_round_kind_key").on(
      table.ownerUserId,
      table.sessionId,
      table.turnId,
      table.kind,
    ),
    unique("user_notifications_dedupe_key").on(
      table.ownerUserId,
      table.dedupeKey,
    ),
    check(
      "user_notifications_kind_check",
      sql`${table.kind} in ('completed','failed','needs_action','sync_failed','reminder')`,
    ),
    index("user_notifications_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
    ),
  ],
);

/**
 * The owner of a byte object. One row per stored object, keyed by a TOS object
 * key that never embeds a Session id, so bytes can outlive the Session that
 * produced them and later be surfaced in a user's drive. Sessions reference
 * bytes through the `artifacts` association table instead of owning them.
 *
 * Object keys embed the tenant and the origin segment but not the Session;
 * Session isolation is enforced by association rows plus API ownership checks.
 *
 * A row is `pending` while its object is being written (`writeLeaseUntil` is a
 * crash-recovery lease), then `none` once committed. Unreferenced, unplaced
 * rows (`folderId` null, no artifact associations) are reaped by the drive GC
 * after `orphanedAt` plus the configured retention.
 */
export const driveFiles = pgTable(
  "drive_files",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    origin: fileOrigin("origin").notNull(),
    tosObjectKey: text("tos_object_key").notNull().unique(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentHash: text("content_hash"),
    sourceSessionId: uuid("source_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    folderId: uuid("folder_id"),
    deletionState: deletionState("deletion_state").default("pending").notNull(),
    writeLeaseUntil: timestamp("write_lease_until", { withTimezone: true }),
    orphanedAt: timestamp("orphaned_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [
    check("drive_files_size_check", sql`${table.sizeBytes} >= 0`),
    index("drive_files_owner_state_idx").on(
      table.ownerUserId,
      table.deletionState,
    ),
    index("drive_files_owner_orphaned_idx").on(
      table.ownerUserId,
      table.orphanedAt,
    ),
    index("drive_files_source_session_idx").on(table.sourceSessionId),
  ],
);

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
    /**
     * Reserved: links an upload to the drive object that owns its bytes once
     * uploads are mirrored into TOS. Null while uploads live only in Ark.
     */
    driveFileId: uuid("drive_file_id").references(() => driveFiles.id, {
      onDelete: "set null",
    }),
    reusedObjectKey: text("reused_object_key"),
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
    index("session_inputs_drive_reference_idx").on(table.driveFileId),
    index("session_inputs_reused_object_idx").on(table.reusedObjectKey),
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
    /**
     * The byte object this Session produced. The bytes are owned by
     * `drive_files`; this row is the Session-side association. Deleting the
     * Session removes the association, not necessarily the bytes.
     */
    driveFileId: uuid("drive_file_id")
      .notNull()
      .references(() => driveFiles.id, { onDelete: "cascade" }),
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
    index("artifacts_drive_file_idx").on(table.driveFileId),
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
    /**
     * `unlimited` keeps usage/reservation accounting for audit and abuse
     * signals but skips product quota rejections and quota interrupts.
     */
    mode: quotaMode("mode").default("enforced").notNull(),
    version: integer("version").default(1).notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
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
    arkSessionId: text("ark_session_id").notNull(),
    status: quotaReservationStatus("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    unique("quota_reservations_user_ark_session_unique").on(
      table.userId,
      table.arkSessionId,
    ),
    index("quota_reservations_active_idx").on(
      table.userId,
      table.status,
      table.expiresAt,
    ),
    index("quota_reservations_user_created_counted_idx")
      .on(table.userId, table.createdAt)
      .where(sql`${table.status} in ('active', 'unknown_outcome', 'consumed')`),
    check(
      "quota_reservations_consumed_ark_identity_check",
      sql`${table.status} <> 'consumed'
          or (
            length(${table.arkSessionId}) > 0
            and ${table.arkSessionId} = btrim(
              ${table.arkSessionId},
              concat(
                chr(9), chr(10), chr(11), chr(12), chr(13), chr(32),
                chr(160), chr(5760),
                chr(8192), chr(8193), chr(8194), chr(8195), chr(8196),
                chr(8197), chr(8198), chr(8199), chr(8200), chr(8201),
                chr(8202), chr(8232), chr(8233), chr(8239), chr(8287),
                chr(12288), chr(65279)
              )
            )
            and ${table.arkSessionId} not like 'pending:%'
          )`,
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
    /**
     * Attribution captured at posting time. The model comes from the
     * Session's create-time verified snapshot (never the Agent's current
     * configuration), paired with `modelAttributionPrecision`; rows that
     * predate the precision column keep their historical model as `unknown`.
     */
    agentKind: agentKind("agent_kind"),
    platformAgentId: uuid("platform_agent_id"),
    personalAgentId: uuid("personal_agent_id"),
    modelId: text("model_id"),
    modelAttributionPrecision: modelAttributionPrecision(
      "model_attribution_precision",
    )
      .default("unknown")
      .notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "usage_ledger_reservation_owner_fk",
      columns: [table.userId, table.arkSessionId],
      foreignColumns: [
        quotaReservations.userId,
        quotaReservations.arkSessionId,
      ],
    })
      .onUpdate("cascade")
      .onDelete("no action"),
    uniqueIndex("usage_ledger_event_metric_unique").on(
      table.userId,
      table.arkSessionId,
      table.arkEventId,
      table.metricType,
    ),
    check("usage_ledger_quantity_check", sql`${table.quantity} >= 0`),
    check(
      "usage_ledger_agent_attribution_check",
      sql`(
        ${table.agentKind} is null
        or (${table.agentKind} = 'platform' and ${table.platformAgentId} is not null and ${table.personalAgentId} is null)
        or (${table.agentKind} = 'personal' and ${table.personalAgentId} is not null and ${table.platformAgentId} is null)
      )`,
    ),
    index("usage_ledger_user_recorded_idx").on(table.userId, table.recordedAt),
    index("usage_ledger_recorded_idx").on(table.recordedAt),
    index("usage_ledger_platform_agent_recorded_idx").on(
      table.platformAgentId,
      table.recordedAt,
    ),
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
    /**
     * Bumped on every claim. State transitions validate (id, locked_by,
     * lease_generation), so an execution whose lease was taken over cannot
     * write checkpoints or outcomes even before its row lock expires.
     */
    leaseGeneration: integer("lease_generation").default(0).notNull(),
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
    /** Same takeover protocol as background_jobs. */
    leaseGeneration: integer("lease_generation").default(0).notNull(),
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
    index("audit_logs_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt,
    ),
    index("audit_logs_resource_created_idx").on(
      table.resourceType,
      table.resourceId,
      table.createdAt,
    ),
    index("audit_logs_action_created_idx").on(table.action, table.createdAt),
    index("audit_logs_request_id_idx").on(table.requestId),
  ],
);

export const messageSubmissions = pgTable(
  "message_submissions",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id").notNull(),
    requestHash: text("request_hash").notNull(),
    content: text("content"),
    temporary: boolean("temporary").notNull().default(false),
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    status: text("status").notNull().default("queued"),
    upstreamEventId: text("upstream_event_id"),
    lastErrorCode: text("last_error_code"),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    retainUntil: timestamp("retain_until", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
    ...timestamps,
  },
  (table) => [
    unique("message_submissions_owner_submission_key").on(
      table.ownerUserId,
      table.submissionId,
    ),
    index("message_submissions_session_sequence_idx").on(
      table.sessionId,
      table.sequence,
    ),
    check(
      "message_submissions_status_check",
      sql`${table.status} in ('queued','sending','accepted','failed','unknown')`,
    ),
  ],
);

/**
 * One user-visible execution. A submission is the durable intent; a Run is
 * what the product shows and what automation/notifications attach to. Both are
 * created in the same transaction so a replay cannot produce a second Run.
 */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    triggerKind: runTriggerKind("trigger_kind").notNull().default("manual"),
    submissionId: uuid("submission_id").notNull(),
    status: runStatus("status").notNull().default("queued"),
    arkSessionId: text("ark_session_id"),
    turnId: uuid("turn_id"),
    automationId: uuid("automation_id"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("runs_owner_submission_key").on(
      table.ownerUserId,
      table.submissionId,
    ),
    foreignKey({
      name: "runs_owner_conversation_fk",
      columns: [table.ownerUserId, table.conversationId],
      foreignColumns: [sessions.ownerUserId, sessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "runs_owner_submission_fk",
      columns: [table.ownerUserId, table.submissionId],
      foreignColumns: [
        messageSubmissions.ownerUserId,
        messageSubmissions.submissionId,
      ],
    }).onDelete("cascade"),
    check("runs_version_positive_check", sql`${table.version} > 0`),
    index("runs_owner_status_idx").on(table.ownerUserId, table.status),
    index("runs_owner_conversation_created_idx").on(
      table.ownerUserId,
      table.conversationId,
      table.createdAt,
    ),
  ],
);

/**
 * Per-owner change feed for multi-browser/multi-device sync. The counter row is
 * locked inside the same transaction as the mutation, so commit order and
 * `seq` order agree; a client never sees a smaller `seq` committed later.
 */
export const syncCounters = pgTable("sync_counters", {
  ownerUserId: uuid("owner_user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const accountChanges = pgTable(
  "account_changes",
  {
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    revision: integer("revision"),
    deleted: boolean("deleted").notNull().default(false),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerUserId, table.seq] }),
    index("account_changes_owner_changed_idx").on(
      table.ownerUserId,
      table.changedAt,
    ),
    index("account_changes_owner_resource_idx").on(
      table.ownerUserId,
      table.resourceType,
      table.resourceId,
    ),
  ],
);

/**
 * Single-consumer lease for a runtime Session's upstream event stream. The
 * worker that holds the lease is the only component allowed to persist live
 * events and drive their side effects; SSE readers consume the local log.
 */
export const sessionEventConsumers = pgTable(
  "session_event_consumers",
  {
    sessionId: uuid("session_id").primaryKey(),
    ownerUserId: uuid("owner_user_id").notNull(),
    consumerId: text("consumer_id").notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    generation: integer("generation").notNull().default(0),
    lastEventId: text("last_event_id"),
    lastConsumedAt: timestamp("last_consumed_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "session_event_consumers_owner_session_fk",
      columns: [table.ownerUserId, table.sessionId],
      foreignColumns: [sessions.ownerUserId, sessions.id],
    }).onDelete("cascade"),
    index("session_event_consumers_lease_idx").on(table.leaseUntil),
  ],
);

/**
 * Reminder-first automation. `schedule` is an IANA-timezone wall-clock rule;
 * `occurrences` are pre-materialized so claiming is a normal leased job and the
 * unique key is the idempotency key.
 */
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    kind: automationKind("kind").default("reminder").notNull(),
    schedule: jsonb("schedule").$type<Record<string, unknown>>().notNull(),
    timezone: text("timezone").notNull(),
    /** Set for execute automations; reminder rows leave it null. */
    prompt: text("prompt"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    scheduleVersion: integer("schedule_version").default(1).notNull(),
    revision: integer("revision").default(1).notNull(),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [
    check("automations_revision_positive_check", sql`${table.revision} > 0`),
    index("automations_owner_next_idx").on(
      table.ownerUserId,
      table.enabled,
      table.nextRunAt,
    ),
  ],
);

export const automationOccurrences = pgTable(
  "automation_occurrences",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    scheduleVersion: integer("schedule_version").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: automationOccurrenceStatus("status").default("pending").notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseGeneration: integer("lease_generation").default(0).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    ...timestamps,
  },
  (table) => [
    unique("automation_occurrences_round_key").on(
      table.automationId,
      table.scheduleVersion,
      table.scheduledAt,
    ),
    index("automation_occurrences_due_idx").on(table.status, table.scheduledAt),
    index("automation_occurrences_owner_idx").on(
      table.ownerUserId,
      table.scheduledAt,
    ),
  ],
);

/**
 * User-registered remote MCP servers. URLs are validated before insert
 * (HTTPS, no credentials, no private/link-local DNS answers); credentials live
 * in Vault and are never stored here.
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    status: mcpServerStatus("status").default("active").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("mcp_servers_owner_name_unique").on(table.ownerUserId, table.name),
    index("mcp_servers_owner_status_idx").on(table.ownerUserId, table.status),
  ],
);
