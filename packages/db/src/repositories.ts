import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { createMemoryRepository } from "./memory-repository.js";
import { createSessionEventRepository } from "./session-event-repository.js";
import { createSessionDeliveryRepository } from "./session-delivery-repository.js";
import { createFileReuseRepository } from "./file-reuse-repository.js";
import { createRunRepository } from "./run-repository.js";
import { createEventIngestorRepository } from "./event-ingestor-repository.js";
import { createAssistantProfileRepository } from "./assistant-profile-repository.js";
import { createInviteRepository } from "./invite-code-repository.js";
import { createAutomationRepository } from "./automation-repository.js";
import { createAccountExportRepository } from "./account-export-repository.js";
import {
  appendAccountChange,
  createSyncRepository,
} from "./sync-repository.js";

type Row = Record<string, unknown>;

interface SubmissionRow extends Row {
  id: string;
  ownerUserId: string;
  sessionId: string;
  submissionId: string;
  requestHash: string;
  content: string | null;
  temporary: boolean;
  sequence: number;
  status: "queued" | "sending" | "accepted" | "failed" | "unknown";
  upstreamEventId: string | null;
  lastErrorCode: string | null;
  leaseGeneration: number;
  createdAt: Date;
  updatedAt: Date;
}
const submissionSelection = sql`id,owner_user_id as "ownerUserId",session_id as "sessionId",submission_id as "submissionId",request_hash as "requestHash",content,temporary,sequence,status,upstream_event_id as "upstreamEventId",last_error_code as "lastErrorCode",lease_generation as "leaseGeneration",created_at as "createdAt",updated_at as "updatedAt"`;

interface QueryResult<T extends Row> {
  rows: T[];
}

interface DatabaseClient {
  execute<T extends Row = Row>(query: SQL): PromiseLike<QueryResult<T>>;
  transaction<T>(
    callback: (transaction: DatabaseClient) => Promise<T>,
  ): Promise<T>;
}

interface OwnedRecord extends Row {
  id: string;
  ownerUserId: string;
}

interface DefaultAgentRecord extends Row {
  userId: string;
  platformAgentId: string;
  assignedBy: string;
  assignedAt: Date;
}

interface AdminUserRecord extends Row {
  id: string;
  email: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  hasPassword: boolean;
  defaultAgentId: string | null;
  quota: {
    personalAgentLimit: number;
    concurrentSessionLimit: number;
    dailySessionLimit: number;
    monthlyTokenLimit: number;
  };
}

interface PlatformAgentRecord extends Row {
  id: string;
  arkAgentId: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  arkVersion: string;
  status: "provisioning" | "active" | "disabled" | "failed" | "deleting";
  createdBy: string;
  updatedBy: string;
  lastErrorCode: string | null;
}

const platformAgentSelection = sql`
  id, ark_agent_id as "arkAgentId", name, description,
  model_id as "modelId", system_prompt as "systemPrompt",
  ark_version as "arkVersion", status,
  created_by as "createdBy", updated_by as "updatedBy",
  last_error_code as "lastErrorCode",
  created_at as "createdAt", updated_at as "updatedAt"`;

interface AgentSkillBinding extends Row {
  skillId: string;
  arkSkillId: string;
  arkVersion: string;
}

interface AgentSkillSummary extends Row {
  id: string;
  displayTitle: string;
}

interface PersonalAgentRecord extends Row {
  id: string;
  ownerUserId: string;
  arkAgentId: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  arkVersion: string;
  status: "provisioning" | "active" | "disabled" | "failed" | "deleting";
  isAutoDefault: boolean;
  skills: AgentSkillBinding[];
  lastErrorCode: string | null;
}

interface AvailableAgentRecord extends Row {
  id: string;
  arkAgentId: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  arkVersion: string;
  status: PersonalAgentRecord["status"];
  kind: "platform" | "personal";
  editable: boolean;
  isAutoDefault: boolean;
  skills: AgentSkillSummary[];
}

interface SkillRecord extends Row {
  id: string;
  ownerUserId: string | null;
  arkSkillId: string;
  name: string;
  displayTitle: string;
  description: string;
  latestVersion: string;
  source: "custom" | "skill_hub";
  fileName: string;
  fileSize: number;
  status: "provisioning" | "active" | "failed" | "deleting";
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const skillSelection = sql`
  id, owner_user_id as "ownerUserId", ark_skill_id as "arkSkillId",
  name, display_title as "displayTitle", description,
  latest_version as "latestVersion", source,
  file_name as "fileName", file_size::double precision as "fileSize", status,
  last_error_code as "lastErrorCode",
  created_at as "createdAt", updated_at as "updatedAt"`;

interface SessionConfigSnapshot {
  agentId: string;
  agentVersion: string;
  environmentId: string;
  modelId: string | null;
  skills: Array<{
    type: string | null;
    skillId: string | null;
    version: string | null;
    useLatest: boolean | null;
    displayName: string | null;
  }> | null;
  tools: Array<{
    type: string | null;
    name: string | null;
    mcpServerName: string | null;
    configuredToolNames: string[] | null;
  }> | null;
  environment: {
    id: string | null;
    type: string | null;
    configType: string | null;
    scope: string | null;
  };
  completeness: "complete" | "incomplete";
}

interface SessionRecordData {
  id: string;
  ownerUserId: string;
  arkSessionId: string;
  agentKind: "platform" | "personal";
  platformAgentId: string | null;
  personalAgentId: string | null;
  arkAgentId: string;
  agentName: string;
  agentVersion: string;
  environmentId: string;
  createAttemptedAt: Date | null;
  modelId: string | null;
  configSnapshot: SessionConfigSnapshot | null;
  configSnapshotState: "unverified" | "verified" | "incomplete" | "mismatch";
  configSnapshotErrorCode: string | null;
  memoryStoreId?: string | null;
  title: string;
  status:
    | "idle"
    | "running"
    | "rescheduled"
    | "terminated"
    | "initializing"
    | "upgrading"
    | "failed";
  lastErrorCode: string | null;
  errorRecoverable: boolean | null;
  archivedAt: Date | null;
  pinnedAt: Date | null;
  deletionState: "none" | "pending" | "deletion_failed" | "deleted";
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SessionRecord extends SessionRecordData, Row {}

interface SessionInputRecord extends Row {
  id: string;
  ownerUserId: string;
  sessionId: string | null;
  arkFileId: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  mountPath: string;
  status: "uploading" | "uploaded" | "bound" | "failed" | "deleting";
  expiresAt: Date;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ArtifactRecord {
  id: string;
  ownerUserId: string;
  sessionId: string;
  arkFileId: string;
  driveFileId: string;
  tosObjectKey: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  generatedAt: Date;
  deletionState: "none" | "pending" | "deletion_failed" | "deleted";
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredSessionEventInput {
  eventId: string;
  sourceType: string;
  type: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

const sessionSelection = sql`
  id, owner_user_id as "ownerUserId",
  ark_session_id as "arkSessionId", agent_kind as "agentKind",
  platform_agent_id as "platformAgentId",
  personal_agent_id as "personalAgentId",
  ark_agent_id as "arkAgentId", agent_name as "agentName",
  agent_version as "agentVersion", environment_id as "environmentId",
  create_attempted_at as "createAttemptedAt", model_id as "modelId",
  config_snapshot as "configSnapshot",
  config_snapshot_state as "configSnapshotState",
  config_snapshot_error_code as "configSnapshotErrorCode",
  memory_store_id as "memoryStoreId",
  title, status, last_error_code as "lastErrorCode",
  error_recoverable as "errorRecoverable", archived_at as "archivedAt",
  pinned_at as "pinnedAt",
  deletion_state as "deletionState", last_event_at as "lastEventAt",
  created_at as "createdAt", updated_at as "updatedAt"`;

const sessionInputSelection = sql`
  id, owner_user_id as "ownerUserId", session_id as "sessionId",
  ark_file_id as "arkFileId", original_name as "originalName",
  mime_type as "mimeType", size_bytes as "sizeBytes",
  mount_path as "mountPath", status, expires_at as "expiresAt",
  last_error_code as "lastErrorCode",
  created_at as "createdAt", updated_at as "updatedAt"`;

/**
 * The object key lives on the owning drive row, so it is projected from there
 * rather than stored on the association. Every query using this selection reads
 * `from artifacts` un-aliased so the correlated reference resolves.
 */
const artifactSelection = sql`
  artifacts.id, artifacts.owner_user_id as "ownerUserId",
  artifacts.session_id as "sessionId",
  artifacts.ark_file_id as "arkFileId",
  artifacts.drive_file_id as "driveFileId",
  (select drive.tos_object_key
     from drive_files drive
    where drive.id = artifacts.drive_file_id) as "tosObjectKey",
  artifacts.name, artifacts.mime_type as "mimeType",
  artifacts.size_bytes as "sizeBytes",
  artifacts.generated_at as "generatedAt",
  artifacts.deletion_state as "deletionState",
  artifacts.last_error_code as "lastErrorCode",
  artifacts.created_at as "createdAt", artifacts.updated_at as "updatedAt"`;

const driveFileSelection = sql`
  id, owner_user_id as "ownerUserId", origin,
  tos_object_key as "tosObjectKey", name, mime_type as "mimeType",
  size_bytes as "sizeBytes", content_hash as "contentHash",
  source_session_id as "sourceSessionId", folder_id as "folderId",
  deletion_state as "deletionState",
  write_lease_until as "writeLeaseUntil", orphaned_at as "orphanedAt",
  last_error_code as "lastErrorCode",
  created_at as "createdAt", updated_at as "updatedAt"`;

interface DriveFileRecord extends Row {
  id: string;
  ownerUserId: string;
  origin: "upload" | "artifact" | "import";
  tosObjectKey: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string | null;
  sourceSessionId: string | null;
  folderId: string | null;
  deletionState: "none" | "pending" | "deletion_failed" | "deleted";
  writeLeaseUntil: Date | null;
  orphanedAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregated Skill bindings for a personal Agent row, aliased into the shape
 * `AgentSkillBinding` expects. The subquery assumes the outer row is
 * `personal_agents` (the column names are resolved against it).
 */
const personalAgentBindingsJson = sql`
  coalesce(
    (select json_agg(
              json_build_object('skillId', pas.skill_id::text,
                                'arkSkillId', pas.ark_skill_id,
                                'arkVersion', pas.ark_version)
              order by pas.skill_id)
       from personal_agent_skills pas
      where pas.agent_id = personal_agents.id),
    '[]'::json)`;

/** Agent-visible Skill summaries for the workspace/admin views. */
function agentSkillSummariesFor(agentAlias: string): SQL {
  return sql`
  coalesce(
    (select json_agg(
              json_build_object('id', s.id::text,
                                'displayTitle', s.display_title)
              order by s.display_title, s.id)
       from personal_agent_skills pas
       join skills s on s.id = pas.skill_id
      where pas.agent_id = ${sql.raw(agentAlias)}.id),
    '[]'::json)`;
}

interface AdminUserAgentRecord extends Row {
  id: string;
  name: string;
  description: string;
  modelId: string;
  arkVersion: string;
  status: PersonalAgentRecord["status"];
  isAutoDefault: boolean;
  ownerUserId: string;
  ownerEmail: string;
  skills: AgentSkillSummary[];
  createdAt: Date;
  updatedAt: Date;
}

const personalAgentSelection = sql`
  id, owner_user_id as "ownerUserId", ark_agent_id as "arkAgentId",
  name, description, model_id as "modelId",
  system_prompt as "systemPrompt", ark_version as "arkVersion", status,
  is_auto_default as "isAutoDefault",
  ${personalAgentBindingsJson} as skills,
  last_error_code as "lastErrorCode",
  created_at as "createdAt", updated_at as "updatedAt"`;

interface EffectiveQuota extends Row {
  personalAgentLimit: number;
  concurrentSessionLimit: number;
  dailySessionLimit: number;
  monthlyTokenLimit: number;
  mode: "enforced" | "unlimited";
  version: number;
}

type UsageMetricType =
  "input_tokens" | "output_tokens" | "runtime_ms" | "tool_calls";

interface JobRecord extends Row {
  id: string;
  ownerUserId: string | null;
  type:
    | "delete_session"
    | "delete_artifact"
    | "cleanup_artifact_object"
    | "cleanup_drive_object"
    | "cleanup_upload"
    | "reconcile_session"
    | "reconcile_personal_agent";
  status: "running";
  priority: number;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedAt: Date;
  lockedBy: string;
  leaseGeneration: number;
  createdAt: Date;
}

interface QuotaInterruptJobRecord extends Row {
  id: string;
  userId: string;
  sessionId: string;
  arkSessionId: string;
  monthStart: Date;
  attempts: number;
  maxAttempts: number;
  leaseGeneration: number;
}

const JOB_LEASE_DURATION_MS = 5 * 60 * 1_000;
const ARTIFACT_DELETION_ERROR_CODES = new Set([
  "ARTIFACT_DELETE_FAILED",
  "ARTIFACT_DELETE_INVALID_JOB",
  "ARTIFACT_DELETE_LEASE_EXPIRED",
  "STORAGE_UNAVAILABLE",
]);
const ARTIFACT_CLEANUP_ERROR_CODES = new Set([
  "ARTIFACT_CLEANUP_FAILED",
  "ARTIFACT_CLEANUP_INVALID_JOB",
  "ARTIFACT_CLEANUP_LEASE_EXPIRED",
  "ARTIFACT_CLEANUP_OBJECT_UNVERIFIED",
  "STORAGE_UNAVAILABLE",
]);
const DRIVE_CLEANUP_ERROR_CODES = new Set([
  "DRIVE_CLEANUP_FAILED",
  "DRIVE_CLEANUP_INVALID_JOB",
  "DRIVE_CLEANUP_LEASE_EXPIRED",
  "DRIVE_CLEANUP_OBJECT_UNVERIFIED",
  "STORAGE_UNAVAILABLE",
]);
const SESSION_DELETION_ERROR_CODES = new Set([
  "SESSION_DELETE_FAILED",
  "SESSION_DELETE_INVALID_JOB",
  "SESSION_DELETE_LEASE_EXPIRED",
  "SESSION_DELETE_WAITING",
]);

function driveCleanupErrorCode(error: string): string {
  return DRIVE_CLEANUP_ERROR_CODES.has(error) ? error : "DRIVE_CLEANUP_FAILED";
}

function artifactDeletionErrorCode(error: string): string {
  return ARTIFACT_DELETION_ERROR_CODES.has(error)
    ? error
    : "ARTIFACT_DELETE_FAILED";
}

function artifactCleanupErrorCode(error: string): string {
  return ARTIFACT_CLEANUP_ERROR_CODES.has(error)
    ? error
    : "ARTIFACT_CLEANUP_FAILED";
}

function sessionDeletionErrorCode(error: string): string {
  return SESSION_DELETION_ERROR_CODES.has(error)
    ? error
    : "SESSION_DELETE_FAILED";
}

export class QuotaExceededError extends Error {
  constructor(
    public readonly dimension:
      "concurrent_sessions" | "daily_sessions" | "monthly_tokens",
  ) {
    super(`Quota exceeded: ${dimension}`);
    this.name = "QuotaExceededError";
  }
}

// Drizzle hands back raw driver values from execute(): timestamptz arrives as
// driver text ("2026-09-11 15:56:49.05906+08") while the query builder returns
// Dates. Revive the aliased timestamp columns here so every repository method
// returns the Date its type declares.
const timestampFields = new Set([
  "archivedAt",
  "assignedAt",
  "createdAt",
  "expiresAt",
  "generatedAt",
  "historyBackfilledAt",
  "lastEventAt",
  "lastObservedAt",
  "lockedAt",
  "monthStart",
  "occurredAt",
  "pinnedAt",
  "runAfter",
  "runningSince",
  "updatedAt",
]);

function reviveTimestamps<T extends Row>(row: T): T {
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string" || !timestampFields.has(key)) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) row[key as keyof T] = parsed as never;
  }
  return row;
}

async function rows<T extends Row>(
  database: DatabaseClient,
  query: SQL,
): Promise<T[]> {
  const result = await database.execute<T>(query);
  return result.rows.map((row) => reviveTimestamps(row));
}

async function first<T extends Row>(
  database: DatabaseClient,
  query: SQL,
): Promise<T | undefined> {
  return (await rows<T>(database, query))[0];
}

async function requiredFirst<T extends Row>(
  database: DatabaseClient,
  query: SQL,
): Promise<T> {
  const result = await first<T>(database, query);
  if (!result) throw new Error("Expected repository mutation to return a row");
  return result;
}

type ConsumableReservationStatus =
  "active" | "unknown_outcome" | "consumed" | "released";

interface ConsumableReservation extends Row {
  id: string;
  userId: string;
  arkSessionId: string;
  status: ConsumableReservationStatus;
  resolvedAt: Date | null;
}

function assertVerifiedArkSessionId(arkSessionId: string) {
  const trimmed = arkSessionId.trim();
  if (
    trimmed.length === 0 ||
    arkSessionId !== trimmed ||
    trimmed.startsWith("pending:")
  ) {
    throw new Error(
      "A verified Ark Session ID must be non-empty, unpadded, and outside the pending namespace",
    );
  }
}

async function consumeReservationIdentity(
  database: DatabaseClient,
  input: {
    reservationId: string;
    arkSessionId: string;
    userId?: string;
  },
): Promise<ConsumableReservation | undefined> {
  assertVerifiedArkSessionId(input.arkSessionId);
  const reservation = await first<ConsumableReservation>(
    database,
    sql`select id, user_id as "userId", ark_session_id as "arkSessionId",
               status, resolved_at as "resolvedAt"
          from quota_reservations
         where id = ${input.reservationId}
           ${input.userId ? sql`and user_id = ${input.userId}` : sql``}
         for update`,
  );
  if (!reservation || reservation.status === "released") {
    return undefined;
  }
  if (reservation.status === "consumed") {
    if (reservation.arkSessionId !== input.arkSessionId) {
      throw new Error("Consumed reservation Ark Session ID is immutable");
    }
    return reservation;
  }
  return requiredFirst<ConsumableReservation>(
    database,
    sql`update quota_reservations
          set ark_session_id = ${input.arkSessionId},
              status = 'consumed',
              resolved_at = now()
        where id = ${input.reservationId}
          and status in ('active', 'unknown_outcome')
        returning id, user_id as "userId",
                  ark_session_id as "arkSessionId", status,
                  resolved_at as "resolvedAt"`,
  );
}

async function assertSessionIdentityCanBeObserved(
  database: DatabaseClient,
  input: { sessionId: string; userId: string; arkSessionId: string },
) {
  const session = await requiredFirst<{ arkSessionId: string }>(
    database,
    sql`select ark_session_id as "arkSessionId"
          from sessions
         where id = ${input.sessionId}
           and owner_user_id = ${input.userId}
         for update`,
  );
  if (
    session.arkSessionId !== `pending:${input.sessionId}` &&
    session.arkSessionId !== input.arkSessionId
  ) {
    throw new Error("Session Ark Session ID is immutable");
  }
}

function tenantRepository(database: DatabaseClient, tableName: SQL) {
  return {
    findOwned(ownerUserId: string, id: string) {
      return first<OwnedRecord>(
        database,
        sql`select id, owner_user_id as "ownerUserId"
              from ${tableName}
             where id = ${id} and owner_user_id = ${ownerUserId}
             limit 1`,
      );
    },
  };
}

async function effectiveQuota(
  database: DatabaseClient,
  userId: string,
): Promise<EffectiveQuota> {
  const quota = await first<EffectiveQuota>(
    database,
    sql`select
          coalesce(o.personal_agent_limit, p.personal_agent_limit)::integer
            as "personalAgentLimit",
          coalesce(o.concurrent_session_limit, p.concurrent_session_limit)::integer
            as "concurrentSessionLimit",
          coalesce(o.daily_session_limit, p.daily_session_limit)::integer
            as "dailySessionLimit",
          coalesce(o.monthly_token_limit, p.monthly_token_limit)::bigint
            as "monthlyTokenLimit",
          p.mode, p.version
        from quota_policies p
        left join user_quota_overrides o on o.user_id = ${userId}
        where p.key = 'default'`,
  );

  if (!quota) {
    throw new Error("Default quota policy is not configured");
  }
  return {
    personalAgentLimit: Number(quota.personalAgentLimit),
    concurrentSessionLimit: Number(quota.concurrentSessionLimit),
    dailySessionLimit: Number(quota.dailySessionLimit),
    monthlyTokenLimit: Number(quota.monthlyTokenLimit),
    mode: quota.mode === "unlimited" ? "unlimited" : "enforced",
    version: Number(quota.version ?? 1),
  };
}

function utcMonthWindow(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    ),
    end: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    ),
  };
}

function utcDayWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  return {
    start,
    end: new Date(start.getTime() + 24 * 60 * 60_000),
  };
}

async function preserveExpiredCreateOutcomes(
  database: DatabaseClient,
  userId: string,
  now: Date,
): Promise<void> {
  await database.execute(
    sql`update quota_reservations
           set status = 'unknown_outcome',
               resolved_at = null
         where user_id = ${userId}
           and status = 'active'
           and expires_at <= ${now}`,
  );
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

async function lockAdminTarget(
  database: DatabaseClient,
  input: { userId: string; actorId: string },
): Promise<{ id: string; role: string; status: string } | undefined> {
  return first<{ id: string; role: string; status: string }>(
    database,
    sql`select target.id, target.role::text as role, target.status::text as status
          from users target
          join users administrator on administrator.id = ${input.actorId}
         where target.id = ${input.userId}
           and administrator.role = 'admin'
           and administrator.status = 'active'
         for update of target`,
  );
}

/**
 * Locks every other active administrator before counting, so two concurrent
 * demotions cannot each observe the other as "one remaining admin".
 */
async function countOtherActiveAdmins(
  database: DatabaseClient,
  userId: string,
): Promise<number> {
  const others = await rows<{ id: string }>(
    database,
    sql`select id
          from users
         where role = 'admin'
           and status = 'active'
           and id <> ${userId}
         for update`,
  );
  return others.length;
}

async function revokeAuthSessions(
  database: DatabaseClient,
  userId: string,
): Promise<number> {
  // Bump the credential epoch in the same transaction: every session the
  // user holds stops authenticating immediately, including any that a racing
  // login inserts after this point (its issued epoch predates the bump).
  await database.execute(
    sql`update users
           set auth_epoch = auth_epoch + 1, updated_at = now()
         where id = ${userId}`,
  );
  const revoked = await first<{ count: number }>(
    database,
    sql`with revoked as (
          update auth_sessions
             set revoked_at = now()
           where user_id = ${userId}
             and revoked_at is null
           returning 1
        )
        select count(*)::integer as count from revoked`,
  );
  return revoked?.count ?? 0;
}

async function insertAuditRow(
  database: DatabaseClient,
  entry: {
    actorUserId: string | null;
    ownerUserId?: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    result: "succeeded" | "failed";
    requestId: string;
    arkRequestId?: string | null;
    errorCode?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  await database.execute(
    sql`insert into audit_logs
          (id, actor_user_id, owner_user_id, action, resource_type,
           resource_id, result, request_id, ark_request_id, error_code,
           metadata)
        values
          (${randomUUID()}, ${entry.actorUserId},
           ${entry.ownerUserId ?? null}, ${entry.action},
           ${entry.resourceType}, ${entry.resourceId ?? null},
           ${entry.result}, ${entry.requestId},
           ${entry.arkRequestId ?? null}, ${entry.errorCode ?? null},
           ${entry.metadata ? JSON.stringify(entry.metadata) : null}::jsonb)`,
  );
}

function buildAuditFilters(query: {
  since?: string;
  until?: string;
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  result?: "succeeded" | "failed";
}): SQL[] {
  const filters: SQL[] = [];
  if (query.since) {
    filters.push(sql`a.created_at >= ${query.since}::timestamptz`);
  }
  if (query.until) {
    filters.push(sql`a.created_at < ${query.until}::timestamptz`);
  }
  if (query.actorId) filters.push(sql`a.actor_user_id = ${query.actorId}`);
  if (query.action) filters.push(sql`a.action = ${query.action}`);
  if (query.resourceType) {
    filters.push(sql`a.resource_type = ${query.resourceType}`);
  }
  if (query.resourceId) filters.push(sql`a.resource_id = ${query.resourceId}`);
  if (query.result) filters.push(sql`a.result = ${query.result}`);
  return filters;
}

async function listAuditLogs(
  database: DatabaseClient,
  filters: SQL[],
  query: { limit: number; before: { createdAt: string; id: string } | null },
) {
  if (query.before) {
    filters.push(
      sql`(a.created_at, a.id) < (${query.before.createdAt}::timestamptz, ${query.before.id}::uuid)`,
    );
  }
  const where =
    filters.length > 0 ? sql`where ${sql.join(filters, sql` and `)}` : sql``;
  const results = await rows<{
    id: string;
    actorUserId: string | null;
    actorEmail: string | null;
    ownerUserId: string | null;
    ownerEmail: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    result: "succeeded" | "failed";
    requestId: string;
    arkRequestId: string | null;
    errorCode: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  }>(
    database,
    sql`select a.id,
               a.actor_user_id as "actorUserId",
               actor.email as "actorEmail",
               a.owner_user_id as "ownerUserId",
               owner.email as "ownerEmail",
               a.action,
               a.resource_type as "resourceType",
               a.resource_id as "resourceId",
               a.result,
               a.request_id as "requestId",
               a.ark_request_id as "arkRequestId",
               a.error_code as "errorCode",
               a.metadata,
               a.created_at as "createdAt"
          from audit_logs a
          left join users actor on actor.id = a.actor_user_id
          left join users owner on owner.id = a.owner_user_id
          ${where}
         order by a.created_at desc, a.id desc
         limit ${query.limit + 1}`,
  );
  const hasMore = results.length > query.limit;
  const entries = hasMore ? results.slice(0, query.limit) : results;
  const last = entries[entries.length - 1];
  return {
    entries,
    nextCursor:
      hasMore && last
        ? {
            createdAt: new Date(last.createdAt).toISOString(),
            id: last.id,
          }
        : null,
  };
}

async function enqueueQuotaInterrupts(
  database: DatabaseClient,
  userId: string,
  monthStart: Date,
  now: Date,
): Promise<void> {
  const active = await rows<{ sessionId: string }>(
    database,
    sql`select id as "sessionId"
          from sessions
         where owner_user_id = ${userId}
           and status in ('running', 'rescheduled')
           and deletion_state = 'none'
         for update`,
  );
  for (const session of active) {
    const inserted = await first<{ id: string }>(
      database,
      sql`insert into quota_interrupt_jobs
            (id, user_id, session_id, month_start, status, attempts, run_after)
          values
            (${randomUUID()}, ${userId}, ${session.sessionId}, ${monthStart},
             'pending', 0, ${now})
          on conflict (user_id, session_id, month_start) do nothing
          returning id`,
    );
    if (!inserted) continue;
    await insertAuditRow(database, {
      actorUserId: null,
      ownerUserId: userId,
      action: "quota_interrupt.enqueue",
      resourceType: "quota_interrupt",
      resourceId: session.sessionId,
      result: "succeeded",
      requestId: "system:quota-interrupt",
      metadata: {
        monthStart: monthStart.toISOString(),
        reason: "monthly_token_limit",
      },
    });
  }
}

async function enqueuePersonalAgentReconciliation(
  database: DatabaseClient,
  input: {
    id: string;
    ownerUserId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await database.execute(
    sql`insert into background_jobs
          (id, owner_user_id, type, status, priority, payload, attempts,
           run_after, locked_at, locked_by, last_error)
        values
          (${input.id}, ${input.ownerUserId}, 'reconcile_personal_agent',
           'pending', 100, ${JSON.stringify(input.payload)}::jsonb, 0,
           now() + interval '30 seconds',
           null, null, null)
        on conflict (id) do update
          set owner_user_id = excluded.owner_user_id,
              type = excluded.type,
              status = 'pending',
              priority = excluded.priority,
              payload = excluded.payload,
              attempts = 0,
              run_after = now() + interval '30 seconds',
              locked_at = null,
              locked_by = null,
              last_error = null,
              updated_at = now()`,
  );
}

async function releaseUnattemptedDurableCreate(
  database: DatabaseClient,
  userId: string,
  sessionId: string,
): Promise<void> {
  const terminal = await first(
    database,
    sql`update sessions set status='terminated',last_error_code='SUBMISSION_FAILED',error_recoverable=false,updated_at=now() where id=${sessionId} and owner_user_id=${userId} and ark_session_id like 'pending:%' and create_attempted_at is null and not exists(select 1 from message_submissions where session_id=${sessionId} and status in ('queued','sending','unknown')) returning id`,
  );
  if (terminal)
    await database.execute(
      sql`update quota_reservations set status='released',resolved_at=now() where id=${sessionId} and user_id=${userId} and status in ('active','unknown_outcome')`,
    );
}

export function createRepositories(database: unknown) {
  const db = database as DatabaseClient;

  return {
    memories: createMemoryRepository(db),
    runs: createRunRepository(db),
    eventConsumers: createEventIngestorRepository(db),
    assistantProfiles: createAssistantProfileRepository(db),
    inviteCodes: createInviteRepository(db),
    automations: createAutomationRepository(db),
    accountExport: createAccountExportRepository(db),
    sync: createSyncRepository(db),
    sessionDelivery: createSessionDeliveryRepository(db),
    fileReuse: createFileReuseRepository(db),
    users: {
      findById(id: string) {
        return first(
          db,
          sql`select id, auth_subject as "authSubject", email, role, status,
                     created_at as "createdAt", updated_at as "updatedAt"
                from users where id = ${id} limit 1`,
        );
      },
      findByAuthSubject(authSubject: string) {
        return first(
          db,
          sql`select id, auth_subject as "authSubject", email, role, status,
                     created_at as "createdAt", updated_at as "updatedAt"
                from users where auth_subject = ${authSubject} limit 1`,
        );
      },
    },

    authSessions: {
      findActiveByTokenHash(tokenHash: string, now = new Date()) {
        return first(
          db,
          sql`select id, user_id as "userId", token_hash as "tokenHash",
                     expires_at as "expiresAt", created_at as "createdAt"
                from auth_sessions
               where token_hash = ${tokenHash}
                 and revoked_at is null
                 and expires_at > ${now}
               limit 1`,
        );
      },
    },

    auditLogs: {
      list(query: {
        since?: string;
        until?: string;
        actorId?: string;
        action?: string;
        resourceType?: string;
        resourceId?: string;
        result?: "succeeded" | "failed";
        limit: number;
        before: { createdAt: string; id: string } | null;
      }) {
        return listAuditLogs(db, buildAuditFilters(query), query);
      },
      listForUser(
        userId: string,
        query: {
          limit: number;
          before: { createdAt: string; id: string } | null;
        },
      ) {
        return listAuditLogs(
          db,
          [sql`(a.actor_user_id = ${userId} or a.owner_user_id = ${userId})`],
          query,
        );
      },
      record(entry: {
        actorUserId: string | null;
        ownerUserId?: string | null;
        action: string;
        resourceType: string;
        resourceId?: string | null;
        result: "succeeded" | "failed";
        requestId: string;
        arkRequestId?: string | null;
        errorCode?: string | null;
        metadata?: Record<string, unknown> | null;
      }) {
        return insertAuditRow(db, entry);
      },
    },

    adminUsers: {
      getUser(userId: string) {
        return first<{
          id: string;
          email: string;
          role: "user" | "admin";
          status: "active" | "disabled";
          hasPassword: boolean;
          defaultAgentId: string | null;
          createdAt: Date;
          updatedAt: Date;
          overridden: {
            personalAgentLimit: boolean;
            concurrentSessionLimit: boolean;
            dailySessionLimit: boolean;
            monthlyTokenLimit: boolean;
          };
        }>(
          db,
          sql`select u.id, u.email, u.role, u.status,
                     (u.password_hash is not null) as "hasPassword",
                     uda.platform_agent_id as "defaultAgentId",
                     u.created_at as "createdAt", u.updated_at as "updatedAt",
                     jsonb_build_object(
                       'personalAgentLimit',
                         coalesce(o.personal_agent_limit is not null, false),
                       'concurrentSessionLimit',
                         coalesce(o.concurrent_session_limit is not null, false),
                       'dailySessionLimit',
                         coalesce(o.daily_session_limit is not null, false),
                       'monthlyTokenLimit',
                         coalesce(o.monthly_token_limit is not null, false)
                     ) as overridden
                from users u
                left join user_default_agents uda on uda.user_id = u.id
                left join user_quota_overrides o on o.user_id = u.id
               where u.id = ${userId}
               limit 1`,
        );
      },
      async listSessions(
        userId: string,
        input: {
          limit: number;
          before: { createdAt: string; id: string } | null;
        },
      ) {
        const filters: SQL[] = [sql`s.owner_user_id = ${userId}`];
        if (input.before) {
          filters.push(
            sql`(s.created_at, s.id) < (${input.before.createdAt}::timestamptz, ${input.before.id}::uuid)`,
          );
        }
        const results = await rows<{
          id: string;
          title: string;
          status: "idle" | "running" | "rescheduled" | "terminated";
          agentKind: "platform" | "personal";
          agentName: string;
          agentVersion: string;
          createdAt: Date;
          lastEventAt: Date | null;
          archivedAt: Date | null;
          deletionState: "none" | "pending" | "deletion_failed" | "deleted";
          tokens: number;
        }>(
          db,
          sql`select s.id, s.title, s.status,
                     s.agent_kind as "agentKind",
                     s.agent_name as "agentName",
                     s.agent_version as "agentVersion",
                     s.created_at as "createdAt",
                     s.last_event_at as "lastEventAt",
                     s.archived_at as "archivedAt",
                     s.deletion_state as "deletionState",
                     coalesce((
                       select sum(ul.quantity)
                         from usage_ledger ul
                        where ul.user_id = s.owner_user_id
                          and ul.ark_session_id = s.ark_session_id
                          and ul.metric_type in ('input_tokens', 'output_tokens')
                     ), 0)::bigint as tokens
                from sessions s
               where ${sql.join(filters, sql` and `)}
               order by s.created_at desc, s.id desc
               limit ${input.limit + 1}`,
        );
        const hasMore = results.length > input.limit;
        const sessions = hasMore ? results.slice(0, input.limit) : results;
        const last = sessions[sessions.length - 1];
        return {
          sessions,
          nextCursor:
            hasMore && last
              ? {
                  createdAt: new Date(last.createdAt).toISOString(),
                  id: last.id,
                }
              : null,
        };
      },
    },

    quotaPolicies: {
      getDefault() {
        return first<{
          key: "default";
          personalAgentLimit: number;
          concurrentSessionLimit: number;
          dailySessionLimit: number;
          monthlyTokenLimit: number;
          mode: "enforced" | "unlimited";
          version: number;
          updatedBy: string | null;
          updatedAt: Date;
        }>(
          db,
          sql`select key, personal_agent_limit as "personalAgentLimit",
                     concurrent_session_limit as "concurrentSessionLimit",
                     daily_session_limit as "dailySessionLimit",
                     monthly_token_limit::bigint as "monthlyTokenLimit",
                     mode, version,
                     updated_by as "updatedBy", updated_at as "updatedAt"
                from quota_policies where key = 'default'`,
        );
      },
      updateDefault(input: {
        quota: {
          personalAgentLimit: number;
          concurrentSessionLimit: number;
          dailySessionLimit: number;
          monthlyTokenLimit: number;
        };
        mode?: "enforced" | "unlimited";
        updatedBy: string;
        now: Date;
      }) {
        return db.transaction(async (transaction) => {
          const previous = await first<{
            key: "default";
            personalAgentLimit: number;
            concurrentSessionLimit: number;
            dailySessionLimit: number;
            monthlyTokenLimit: number;
            mode: "enforced" | "unlimited";
            version: number;
            updatedBy: string | null;
            updatedAt: Date;
          }>(
            transaction,
            sql`select key, personal_agent_limit as "personalAgentLimit",
                       concurrent_session_limit as "concurrentSessionLimit",
                       daily_session_limit as "dailySessionLimit",
                       monthly_token_limit::bigint as "monthlyTokenLimit",
                       mode, version,
                       updated_by as "updatedBy", updated_at as "updatedAt"
                  from quota_policies where key = 'default' for update`,
          );
          if (!previous) return undefined;
          const updated = await first<{
            key: "default";
            personalAgentLimit: number;
            concurrentSessionLimit: number;
            dailySessionLimit: number;
            monthlyTokenLimit: number;
            mode: "enforced" | "unlimited";
            version: number;
            updatedBy: string | null;
            updatedAt: Date;
          }>(
            transaction,
            sql`update quota_policies
                   set personal_agent_limit = ${input.quota.personalAgentLimit},
                       concurrent_session_limit = ${input.quota.concurrentSessionLimit},
                       daily_session_limit = ${input.quota.dailySessionLimit},
                       monthly_token_limit = ${input.quota.monthlyTokenLimit},
                       mode = coalesce(${input.mode ?? null}::quota_mode, mode),
                       version = version + 1,
                       updated_by = ${input.updatedBy},
                       updated_at = now()
                 where key = 'default'
                 returning key, personal_agent_limit as "personalAgentLimit",
                           concurrent_session_limit as "concurrentSessionLimit",
                           daily_session_limit as "dailySessionLimit",
                           monthly_token_limit::bigint as "monthlyTokenLimit",
                           mode, version,
                           updated_by as "updatedBy", updated_at as "updatedAt"`,
          );
          if (!updated) return undefined;
          const window = utcMonthWindow(input.now);
          const overLimit =
            updated.mode === "enforced"
              ? await rows<{ userId: string }>(
                  transaction,
                  sql`select u.id as "userId"
                        from users u
                        join quota_policies p on p.key = 'default'
                        left join user_quota_overrides o on o.user_id = u.id
                       where (
                         select coalesce(sum(ul.quantity), 0)
                           from usage_ledger ul
                          where ul.user_id = u.id
                            and ul.metric_type in ('input_tokens', 'output_tokens')
                            and ul.recorded_at >= ${window.start}
                            and ul.recorded_at < ${window.end}
                       ) >= coalesce(o.monthly_token_limit, p.monthly_token_limit)`,
                )
              : [];
          for (const { userId } of overLimit) {
            await enqueueQuotaInterrupts(
              transaction,
              userId,
              window.start,
              input.now,
            );
          }
          return {
            previous,
            updated,
            overLimitUserIds: overLimit.map(({ userId }) => userId),
          };
        });
      },
      audit(entry: {
        actorUserId: string;
        action: string;
        resourceType: string;
        resourceId?: string;
        result: "succeeded" | "failed";
        requestId: string;
        errorCode?: string;
        metadata?: Record<string, unknown>;
      }) {
        return insertAuditRow(db, entry);
      },
    },

    platformAgents: {
      synchronizeSystemAgents(
        agents: Array<{
          arkAgentId: string;
          name: string;
          description: string;
          modelId: string;
          systemPrompt: string;
          arkVersion: string;
          status: "active" | "disabled";
        }>,
      ) {
        return db.transaction(async (transaction) => {
          // Serialize startup reconciliation across API replicas.
          await transaction.execute(sql`select pg_advisory_xact_lock(734201)`);
          const administrator =
            agents.length > 0
              ? await first<{ id: string }>(
                  transaction,
                  sql`select id from users where role = 'admin' and status = 'active'
                    order by created_at, id limit 1`,
                )
              : undefined;
          if (agents.length > 0 && !administrator) {
            throw new Error(
              "Run npm run admin:seed before configuring SYSTEM_AGENT_IDS",
            );
          }
          const configuredIds = agents.map((agent) => agent.arkAgentId);
          await transaction.execute(
            sql`update platform_agents set status = 'disabled', updated_at = now()
                where status <> 'disabled'
                  ${
                    configuredIds.length > 0
                      ? sql`and ark_agent_id not in (${sql.join(
                          configuredIds.map((agentId) => sql`${agentId}`),
                          sql`, `,
                        )})`
                      : sql``
                  }`,
          );
          for (const [position, agent] of agents.entries()) {
            await transaction.execute(
              sql`insert into platform_agents
                    (id, ark_agent_id, name, description, model_id, system_prompt,
                     ark_version, status, created_by, updated_by, updated_at)
                  values
                    (${randomUUID()}, ${agent.arkAgentId}, ${agent.name},
                     ${agent.description}, ${agent.modelId}, ${agent.systemPrompt},
                     ${agent.arkVersion}, ${agent.status}, ${administrator!.id},
                     ${administrator!.id},
                     transaction_timestamp() + ${position} * interval '1 microsecond')
                  on conflict (ark_agent_id) do update
                    set name = excluded.name, description = excluded.description,
                        model_id = excluded.model_id, ark_version = excluded.ark_version,
                        status = excluded.status,
                        updated_by = excluded.updated_by, last_error_code = null,
                        updated_at = excluded.updated_at`,
            );
          }
        });
      },
      findById(id: string) {
        return first<PlatformAgentRecord>(
          db,
          sql`select ${platformAgentSelection}
                from platform_agents where id = ${id} limit 1`,
        );
      },
      findAssignedToUser(userId: string, platformAgentId: string) {
        return first(
          db,
          sql`select pa.*
                from platform_agents pa
                join users target on target.id = ${userId}
               where target.status = 'active'
                 and target.role = 'user'
                 and pa.id = ${platformAgentId}
                 and pa.status = 'active'
               limit 1`,
        );
      },
      list() {
        return rows<PlatformAgentRecord>(
          db,
          sql`select ${platformAgentSelection}
                from platform_agents
               order by (status = 'active') desc, updated_at asc, id asc`,
        );
      },
      createProvisioning(input: {
        id: string;
        name: string;
        description: string;
        modelId: string;
        systemPrompt: string;
        createdBy: string;
        updatedBy: string;
      }) {
        return first<PlatformAgentRecord>(
          db,
          sql`insert into platform_agents
                (id, ark_agent_id, name, description, model_id, system_prompt,
                 ark_version, status, created_by, updated_by)
              values
                (${input.id}, ${`pending:${input.id}`}, ${input.name},
                 ${input.description}, ${input.modelId}, ${input.systemPrompt},
                 '0', 'provisioning', ${input.createdBy}, ${input.updatedBy})
              returning ${platformAgentSelection}`,
        );
      },
      markProvisioned(
        id: string,
        upstream: { arkAgentId: string; arkVersion: string },
      ) {
        return first<PlatformAgentRecord>(
          db,
          sql`update platform_agents
                set ark_agent_id = ${upstream.arkAgentId},
                    ark_version = ${upstream.arkVersion},
                    status = 'active',
                    last_error_code = null,
                    updated_at = now()
              where id = ${id}
              returning ${platformAgentSelection}`,
        );
      },
      markFailure(
        id: string,
        status: "provisioning" | "failed" | "deleting",
        errorCode: string,
      ) {
        return first<PlatformAgentRecord>(
          db,
          sql`update platform_agents
                set status = ${status},
                    last_error_code = ${errorCode},
                    updated_at = now()
              where id = ${id}
              returning ${platformAgentSelection}`,
        );
      },
      update(
        id: string,
        input: {
          name?: string;
          description?: string;
          modelId?: string;
          systemPrompt?: string;
          arkVersion?: string;
          status?: string;
          updatedBy?: string;
          lastErrorCode?: string | null;
        },
      ) {
        return first<PlatformAgentRecord>(
          db,
          sql`update platform_agents
                set name = coalesce(${input.name ?? null}, name),
                    description = coalesce(${input.description ?? null}, description),
                    model_id = coalesce(${input.modelId ?? null}, model_id),
                    system_prompt = coalesce(${input.systemPrompt ?? null}, system_prompt),
                    ark_version = coalesce(${input.arkVersion ?? null}, ark_version),
                    status = coalesce(${input.status ?? null}, status::text)::agent_status,
                    updated_by = coalesce(${input.updatedBy ?? null}, updated_by),
                    last_error_code = case
                      when ${input.lastErrorCode === null} then null
                      else coalesce(${input.lastErrorCode ?? null}, last_error_code)
                    end,
                    updated_at = now()
              where id = ${id}
              returning ${platformAgentSelection}`,
        );
      },
      beginDelete(id: string, updatedBy: string) {
        return db.transaction(async (transaction) => {
          const current = await first<PlatformAgentRecord>(
            transaction,
            sql`select ${platformAgentSelection}
                  from platform_agents
                 where id = ${id}
                 for update`,
          );
          if (!current) return undefined;

          const references = (await first<{
            assignments: number;
            sessions: number;
          }>(
            transaction,
            sql`select
                    (select count(*)::integer from user_default_agents
                      where platform_agent_id = ${id}) as assignments,
                    (select count(*)::integer from sessions
                      where platform_agent_id = ${id}) as sessions`,
          )) ?? { assignments: 0, sessions: 0 };
          if (references.assignments > 0 || references.sessions > 0) {
            return {
              agent: current,
              previousStatus: current.status,
              references,
            };
          }

          const agent = await first<PlatformAgentRecord>(
            transaction,
            sql`update platform_agents
                  set status = 'deleting',
                      updated_by = ${updatedBy},
                      updated_at = now()
                where id = ${id}
                returning ${platformAgentSelection}`,
          );
          if (!agent) return undefined;
          return {
            agent,
            previousStatus: current.status,
            references,
          };
        });
      },
      async remove(id: string) {
        await db.execute(sql`delete from platform_agents where id = ${id}`);
      },
      assignDefault(input: {
        userId: string;
        platformAgentId: string;
        assignedBy: string;
      }) {
        return db.transaction(async (transaction) => {
          const eligible = await first(
            transaction,
            sql`select pa.id
                  from platform_agents pa
                  join users target on target.id = ${input.userId}
                  join users administrator on administrator.id = ${input.assignedBy}
                 where pa.id = ${input.platformAgentId}
                   and pa.status = 'active'
                   and target.role = 'user'
                   and target.status = 'active'
                   and administrator.role = 'admin'
                   and administrator.status = 'active'
                 for update of pa, target`,
          );
          if (!eligible) return undefined;
          return first<DefaultAgentRecord>(
            transaction,
            sql`insert into user_default_agents
                  (user_id, platform_agent_id, assigned_by)
                values
                  (${input.userId}, ${input.platformAgentId}, ${input.assignedBy})
                on conflict (user_id) do update
                  set platform_agent_id = excluded.platform_agent_id,
                      assigned_by = excluded.assigned_by,
                      assigned_at = now()
                returning user_id as "userId",
                          platform_agent_id as "platformAgentId",
                          assigned_by as "assignedBy",
                          assigned_at as "assignedAt"`,
          );
        });
      },
      async listUsers(
        query: {
          limit: number;
          search: string | null;
          before: { createdAt: string; id: string } | null;
        } = { limit: 50, search: null, before: null },
      ) {
        const filters: SQL[] = [];
        if (query.search) {
          filters.push(
            sql`u.email ilike ${`%${escapeLikePattern(query.search)}%`}`,
          );
        }
        if (query.before) {
          filters.push(
            sql`(u.created_at, u.id) < (${query.before.createdAt}::timestamptz, ${query.before.id}::uuid)`,
          );
        }
        const results = await rows<
          AdminUserRecord & { createdAt: Date; rawCreatedAt: Date }
        >(
          db,
          sql`select u.id, u.email, u.role, u.status,
                     (u.password_hash is not null) as "hasPassword",
                     uda.platform_agent_id as "defaultAgentId",
                     jsonb_build_object(
                       'personalAgentLimit',
                         coalesce(
                           override.personal_agent_limit,
                           policy.personal_agent_limit
                         ),
                       'concurrentSessionLimit',
                         coalesce(
                           override.concurrent_session_limit,
                           policy.concurrent_session_limit
                         ),
                       'dailySessionLimit',
                         coalesce(
                           override.daily_session_limit,
                           policy.daily_session_limit
                         ),
                       'monthlyTokenLimit',
                         coalesce(
                           override.monthly_token_limit,
                           policy.monthly_token_limit
                         )
                     ) as quota,
                     u.created_at as "createdAt"
                from users u
                join quota_policies policy on policy.key = 'default'
                left join user_default_agents uda on uda.user_id = u.id
                left join user_quota_overrides override
                  on override.user_id = u.id
                ${filters.length > 0 ? sql`where ${sql.join(filters, sql` and `)}` : sql``}
               order by u.created_at desc, u.id desc
               limit ${query.limit + 1}`,
        );
        const hasMore = results.length > query.limit;
        const users = hasMore ? results.slice(0, query.limit) : results;
        const last = users[users.length - 1];
        return {
          users,
          nextCursor:
            hasMore && last
              ? {
                  createdAt: new Date(last.createdAt).toISOString(),
                  id: last.id,
                }
              : null,
        };
      },
      setUserStatus(input: {
        userId: string;
        status: "active" | "disabled";
        actorId: string;
      }) {
        return db.transaction(async (transaction) => {
          const target = await lockAdminTarget(transaction, input);
          if (!target) return undefined;
          if (
            input.status === "disabled" &&
            target.role === "admin" &&
            target.status === "active" &&
            (await countOtherActiveAdmins(transaction, input.userId)) === 0
          ) {
            return "last_active_admin" as const;
          }
          await transaction.execute(
            sql`update users
                   set status = ${input.status}, updated_at = now()
                 where id = ${input.userId}`,
          );
          const revokedSessions =
            input.status === "disabled"
              ? await revokeAuthSessions(transaction, input.userId)
              : 0;
          return {
            from: target.status,
            to: input.status,
            revokedSessions,
          };
        });
      },
      setUserRole(input: {
        userId: string;
        role: "user" | "admin";
        actorId: string;
      }) {
        return db.transaction(async (transaction) => {
          const target = await lockAdminTarget(transaction, input);
          if (!target) return undefined;
          if (
            input.role === "user" &&
            target.role === "admin" &&
            target.status === "active" &&
            (await countOtherActiveAdmins(transaction, input.userId)) === 0
          ) {
            return "last_active_admin" as const;
          }
          await transaction.execute(
            sql`update users
                   set role = ${input.role}, updated_at = now()
                 where id = ${input.userId}`,
          );
          const revokedSessions = await revokeAuthSessions(
            transaction,
            input.userId,
          );
          return {
            from: target.role,
            to: input.role,
            revokedSessions,
          };
        });
      },
      async revokeUserSessions(input: { userId: string; actorId: string }) {
        return db.transaction(async (transaction) => {
          const target = await lockAdminTarget(transaction, input);
          if (!target) return undefined;
          return {
            revokedSessions: await revokeAuthSessions(
              transaction,
              input.userId,
            ),
          };
        });
      },
      createUser(input: {
        id: string;
        authSubject: string;
        email: string;
        passwordHash: string;
        role: "user" | "admin";
        createdBy: string;
      }) {
        return db.transaction(async (transaction) => {
          const administrator = await first<{ id: string }>(
            transaction,
            sql`select id
                  from users
                 where id = ${input.createdBy}
                   and role = 'admin'
                   and status = 'active'
                 for update`,
          );
          if (!administrator) return undefined;
          const created = await first<{ id: string }>(
            transaction,
            sql`insert into users
                  (id, auth_subject, email, password_hash, role)
                values
                  (${input.id}, ${input.authSubject}, ${input.email},
                   ${input.passwordHash}, ${input.role})
                on conflict (email) do nothing
                returning id`,
          );
          return created ? { id: created.id } : undefined;
        });
      },
      resetUserPassword(input: {
        userId: string;
        passwordHash: string;
        updatedBy: string;
      }) {
        return db.transaction(async (transaction) => {
          const eligible = await first<{ id: string }>(
            transaction,
            sql`select target.id
                  from users target
                  join users administrator on administrator.id = ${input.updatedBy}
                 where target.id = ${input.userId}
                   and administrator.role = 'admin'
                   and administrator.status = 'active'
                 for update of target`,
          );
          if (!eligible) return false;
          await transaction.execute(
            sql`update users
                   set password_hash = ${input.passwordHash},
                       auth_epoch = auth_epoch + 1,
                       updated_at = now()
                 where id = ${input.userId}`,
          );
          await transaction.execute(
            sql`update auth_sessions
                   set revoked_at = now()
                 where user_id = ${input.userId}
                   and revoked_at is null`,
          );
          return true;
        });
      },
      updateUserQuota(input: {
        userId: string;
        personalAgentLimit: number | null;
        concurrentSessionLimit: number | null;
        dailySessionLimit: number | null;
        monthlyTokenLimit: number | null;
        updatedBy: string;
      }) {
        return db.transaction(async (transaction) => {
          const eligible = await first(
            transaction,
            sql`select target.id
                  from users target
                  join users administrator on administrator.id = ${input.updatedBy}
                 where target.id = ${input.userId}
                   and target.role = 'user'
                   and administrator.role = 'admin'
                   and administrator.status = 'active'
                 for update of target`,
          );
          if (!eligible) return undefined;
          const previous = await effectiveQuota(transaction, input.userId);
          const overrides = [
            input.personalAgentLimit,
            input.concurrentSessionLimit,
            input.dailySessionLimit,
            input.monthlyTokenLimit,
          ];
          if (overrides.every((value) => value === null)) {
            await transaction.execute(
              sql`delete from user_quota_overrides
                   where user_id = ${input.userId}`,
            );
          } else {
            await transaction.execute(
              sql`insert into user_quota_overrides
                    (user_id, personal_agent_limit, concurrent_session_limit,
                     daily_session_limit, monthly_token_limit, updated_by)
                  values
                    (${input.userId}, ${input.personalAgentLimit},
                     ${input.concurrentSessionLimit}, ${input.dailySessionLimit},
                     ${input.monthlyTokenLimit}, ${input.updatedBy})
                  on conflict (user_id) do update
                    set personal_agent_limit = excluded.personal_agent_limit,
                        concurrent_session_limit = excluded.concurrent_session_limit,
                        daily_session_limit = excluded.daily_session_limit,
                        monthly_token_limit = excluded.monthly_token_limit,
                        updated_by = excluded.updated_by,
                        updated_at = now()`,
            );
          }
          const effective = await effectiveQuota(transaction, input.userId);
          const overrideRow = await first<{
            personalAgentLimit: boolean;
            concurrentSessionLimit: boolean;
            dailySessionLimit: boolean;
            monthlyTokenLimit: boolean;
          }>(
            transaction,
            sql`select personal_agent_limit is not null as "personalAgentLimit",
                       concurrent_session_limit is not null
                         as "concurrentSessionLimit",
                       daily_session_limit is not null as "dailySessionLimit",
                       monthly_token_limit is not null as "monthlyTokenLimit"
                  from user_quota_overrides where user_id = ${input.userId}`,
          );
          const overridden = {
            personalAgentLimit: overrideRow?.personalAgentLimit ?? false,
            concurrentSessionLimit:
              overrideRow?.concurrentSessionLimit ?? false,
            dailySessionLimit: overrideRow?.dailySessionLimit ?? false,
            monthlyTokenLimit: overrideRow?.monthlyTokenLimit ?? false,
          };
          const now = new Date();
          const window = utcMonthWindow(now);
          const usage = await first<{ total: number }>(
            transaction,
            sql`select coalesce(sum(quantity), 0)::bigint as total
                  from usage_ledger
                 where user_id = ${input.userId}
                   and metric_type in ('input_tokens', 'output_tokens')
                   and recorded_at >= ${window.start}
                   and recorded_at < ${window.end}`,
          );
          const monthTokens = Number(usage?.total ?? 0);
          if (
            effective.mode === "enforced" &&
            monthTokens >= effective.monthlyTokenLimit
          ) {
            await enqueueQuotaInterrupts(
              transaction,
              input.userId,
              window.start,
              now,
            );
          }
          return { previous, effective, overridden, monthTokens };
        });
      },
      async audit(input: {
        actorUserId: string;
        ownerUserId?: string;
        action: string;
        resourceType: string;
        resourceId?: string;
        result: "succeeded" | "failed";
        requestId: string;
        arkRequestId?: string;
        errorCode?: string;
        metadata?: Record<string, unknown>;
      }) {
        await insertAuditRow(db, input);
      },
    },

    personalAgents: tenantRepository(db, sql.raw("personal_agents")),
    userAgents: {
      listAvailable(userId: string) {
        return rows<AvailableAgentRecord>(
          db,
          sql`select *
                from (
                  select pa.id, pa.ark_agent_id as "arkAgentId", pa.name,
                         pa.description, pa.model_id as "modelId",
                         pa.system_prompt as "systemPrompt",
                         pa.ark_version as "arkVersion", pa.status,
                         'platform'::text as kind, false as editable,
                         false as "isAutoDefault", '[]'::json as skills,
                         pa.updated_at as "createdAt"
                    from platform_agents pa
                    join users target on target.id = ${userId}
                   where target.role = 'user'
                     and target.status = 'active'
                     and pa.status = 'active'
                  union all
                  select ua.id, ua.ark_agent_id as "arkAgentId", ua.name,
                         ua.description, ua.model_id as "modelId",
                         ua.system_prompt as "systemPrompt",
                         ua.ark_version as "arkVersion", ua.status,
                         'personal'::text as kind, true as editable,
                         ua.is_auto_default as "isAutoDefault",
                         ${agentSkillSummariesFor("ua")} as skills,
                         ua.created_at as "createdAt"
                    from personal_agents ua
                   where ua.owner_user_id = ${userId}
                ) available
               order by case when kind = 'platform' then 0 else 1 end,
                        "createdAt" asc, id asc`,
        );
      },
      async findRecentAvailable(userId: string) {
        const recent = await first<{ agentId: string }>(
          db,
          sql`select case
                       when s.agent_kind = 'platform' then s.platform_agent_id
                       else s.personal_agent_id
                     end as "agentId"
                from sessions s
                join users target on target.id = ${userId}
                left join platform_agents pa
                  on pa.id = s.platform_agent_id
                left join personal_agents ua
                  on ua.id = s.personal_agent_id
                 and ua.owner_user_id = s.owner_user_id
               where s.owner_user_id = ${userId}
                 and target.role = 'user'
                 and target.status = 'active'
                 and (
                   (s.agent_kind = 'platform'
                    and pa.status = 'active')
                   or
                   (s.agent_kind = 'personal' and ua.status = 'active')
                 )
               order by s.created_at desc, s.id desc
               limit 1`,
        );
        return recent?.agentId;
      },
      async findDefaultActive(userId: string) {
        const assignment = await first<{ agentId: string }>(
          db,
          sql`select pa.id as "agentId"
                from platform_agents pa
                join users target on target.id = ${userId}
                left join user_default_agents uda
                  on uda.platform_agent_id = pa.id
                 and uda.user_id = ${userId}
               where target.role = 'user'
                 and target.status = 'active'
                 and pa.status = 'active'
               order by (uda.user_id is not null) desc,
                        pa.updated_at asc, pa.id asc
               limit 1`,
        );
        return assignment?.agentId;
      },
      findAutoDefault(userId: string) {
        return first<PersonalAgentRecord>(
          db,
          sql`select ${personalAgentSelection}
                from personal_agents
               where owner_user_id = ${userId}
                 and is_auto_default
               limit 1`,
        );
      },
      async findPlatformTemplate(userId: string) {
        return first<{
          name: string;
          description: string;
          modelId: string;
        }>(
          db,
          sql`select pa.name, pa.description, pa.model_id as "modelId"
                from platform_agents pa
                join users target on target.id = ${userId}
                left join user_default_agents uda
                  on uda.platform_agent_id = pa.id
                 and uda.user_id = ${userId}
               where target.role = 'user'
                 and target.status = 'active'
                 and pa.status = 'active'
               order by (uda.user_id is not null) desc,
                        pa.updated_at asc, pa.id asc
               limit 1`,
        );
      },
      listAgentsBoundToSkill(skillId: string) {
        return rows<PersonalAgentRecord>(
          db,
          sql`select ${personalAgentSelection}
                from personal_agents
               where id in (
                 select agent_id from personal_agent_skills
                  where skill_id = ${skillId}
               )
               order by created_at asc, id asc`,
        );
      },
      async replaceSkillBindings(
        agentId: string,
        userId: string,
        bindings: AgentSkillBinding[],
      ) {
        await db.transaction(async (transaction) => {
          const agent = await first<{ id: string }>(
            transaction,
            sql`select id from personal_agents
                 where id = ${agentId} and owner_user_id = ${userId}
                 for update`,
          );
          if (!agent) throw new Error("Agent not found");
          await transaction.execute(
            sql`delete from personal_agent_skills
                 where agent_id = ${agentId}`,
          );
          if (bindings.length === 0) return;
          const now = new Date();
          await transaction.execute(
            sql`insert into personal_agent_skills
                  (agent_id, skill_id, ark_skill_id, ark_version, added_at)
                select ${agentId}, x."skillId", x."arkSkillId",
                       x."arkVersion", ${now}
                  from jsonb_to_recordset(
                    ${JSON.stringify(
                      bindings.map((binding) => ({
                        skillId: binding.skillId,
                        arkSkillId: binding.arkSkillId,
                        arkVersion: binding.arkVersion,
                      })),
                    )}::jsonb
                  ) as x("skillId" uuid, "arkSkillId" text, "arkVersion" text)`,
          );
        });
      },
      findAvailableById(userId: string, id: string) {
        return first<AvailableAgentRecord>(
          db,
          sql`select *
                from (
                  select pa.id, pa.ark_agent_id as "arkAgentId", pa.name,
                         pa.description, pa.model_id as "modelId",
                         pa.system_prompt as "systemPrompt",
                         pa.ark_version as "arkVersion", pa.status,
                         'platform'::text as kind, false as editable,
                         false as "isAutoDefault", '[]'::json as skills
                    from platform_agents pa
                    join users target on target.id = ${userId}
                   where target.role = 'user'
                     and target.status = 'active'
                     and pa.id = ${id}
                     and pa.status = 'active'
                  union all
                  select ua.id, ua.ark_agent_id as "arkAgentId", ua.name,
                         ua.description, ua.model_id as "modelId",
                         ua.system_prompt as "systemPrompt",
                         ua.ark_version as "arkVersion", ua.status,
                         'personal'::text as kind, true as editable,
                         ua.is_auto_default as "isAutoDefault",
                         ${agentSkillSummariesFor("ua")} as skills
                    from personal_agents ua
                   where ua.owner_user_id = ${userId}
                     and ua.id = ${id}
                     and ua.status = 'active'
                ) available
               limit 1`,
        );
      },
      createProvisioning(input: {
        id: string;
        ownerUserId: string;
        name: string;
        description: string;
        modelId: string;
        systemPrompt: string;
        isAutoDefault: boolean;
        skills: AgentSkillBinding[];
      }) {
        return db.transaction(async (transaction) => {
          const user = await first(
            transaction,
            sql`select id from users
                 where id = ${input.ownerUserId}
                   and role = 'user'
                   and status = 'active'
                 for update`,
          );
          if (!user) return undefined;
          const quota = await effectiveQuota(transaction, input.ownerUserId);
          const usage = await first<{ count: number }>(
            transaction,
            sql`select count(*)::integer as count
                  from personal_agents
                 where owner_user_id = ${input.ownerUserId}
                   and not (
                     status = 'failed'
                     and ark_version = '0'
                     and ark_agent_id like 'pending:%'
                   )`,
          );
          if (
            quota.mode === "enforced" &&
            (usage?.count ?? 0) >= quota.personalAgentLimit
          )
            return undefined;
          const created = await requiredFirst<PersonalAgentRecord>(
            transaction,
            sql`insert into personal_agents
                  (id, owner_user_id, ark_agent_id, name, description, model_id,
                   system_prompt, ark_version, status, is_auto_default)
                values
                  (${input.id}, ${input.ownerUserId}, ${`pending:${input.id}`},
                   ${input.name}, ${input.description}, ${input.modelId},
                   ${input.systemPrompt}, '0', 'provisioning',
                   ${input.isAutoDefault ?? false})
                returning ${personalAgentSelection}`,
          );
          if ((input.skills ?? []).length > 0) {
            await transaction.execute(
              sql`insert into personal_agent_skills
                    (agent_id, skill_id, ark_skill_id, ark_version)
                  select ${input.id}, x."skillId", x."arkSkillId",
                         x."arkVersion"
                    from jsonb_to_recordset(
                      ${JSON.stringify(
                        (input.skills ?? []).map((binding) => ({
                          skillId: binding.skillId,
                          arkSkillId: binding.arkSkillId,
                          arkVersion: binding.arkVersion,
                        })),
                      )}::jsonb
                    ) as x("skillId" uuid, "arkSkillId" text, "arkVersion" text)`,
            );
          }
          await enqueuePersonalAgentReconciliation(transaction, {
            id: input.id,
            ownerUserId: input.ownerUserId,
            payload: {
              operation: "create",
              personalAgentId: input.id,
            },
          });
          return created;
        });
      },
      findOwned(userId: string, id: string) {
        return first<PersonalAgentRecord>(
          db,
          sql`select ${personalAgentSelection}
                from personal_agents
               where id = ${id} and owner_user_id = ${userId}
               limit 1`,
        );
      },
      markProvisioned(
        id: string,
        userId: string,
        upstream: { arkAgentId: string; arkVersion: string },
      ) {
        return db.transaction(async (transaction) => {
          const job = await requiredFirst<{ status: string }>(
            transaction,
            sql`select status
                  from background_jobs
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and type = 'reconcile_personal_agent'
                 for update`,
          );
          if (job.status === "failed") {
            throw new Error("Personal Agent create reconciliation is terminal");
          }
          const agent = await requiredFirst<PersonalAgentRecord>(
            transaction,
            sql`update personal_agents
                  set ark_agent_id = ${upstream.arkAgentId},
                      ark_version = ${upstream.arkVersion},
                      status = 'active',
                      last_error_code = null,
                      updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                returning ${personalAgentSelection}`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'succeeded',
                      locked_at = null,
                      locked_by = null,
                      last_error = null,
                      updated_at = now()
                where id = ${id} and owner_user_id = ${userId}`,
          );
          return agent;
        });
      },
      markFailure(
        id: string,
        userId: string,
        status: "provisioning" | "failed" | "deleting",
        errorCode: string,
      ) {
        return requiredFirst<PersonalAgentRecord>(
          db,
          sql`update personal_agents
                set status = ${status},
                    last_error_code = ${errorCode},
                    updated_at = now()
              where id = ${id} and owner_user_id = ${userId}
              returning ${personalAgentSelection}`,
        );
      },
      markDefinitiveCreateFailure(
        id: string,
        userId: string,
        errorCode: string,
      ) {
        return db.transaction(async (transaction) => {
          const job = await requiredFirst<{ status: string }>(
            transaction,
            sql`select status
                  from background_jobs
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and type = 'reconcile_personal_agent'
                 for update`,
          );
          if (job.status === "succeeded") {
            return requiredFirst<PersonalAgentRecord>(
              transaction,
              sql`select ${personalAgentSelection}
                    from personal_agents
                   where id = ${id} and owner_user_id = ${userId}`,
            );
          }
          const agent = await requiredFirst<PersonalAgentRecord>(
            transaction,
            sql`update personal_agents
                  set status = 'failed',
                      last_error_code = ${errorCode},
                      updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                returning ${personalAgentSelection}`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'failed',
                      locked_at = null,
                      locked_by = null,
                      last_error = ${errorCode},
                      updated_at = now()
                where id = ${id}
                  and owner_user_id = ${userId}
                  and type = 'reconcile_personal_agent'`,
          );
          return agent;
        });
      },
      markCreatePersistenceFailure(
        id: string,
        userId: string,
        upstream: { arkAgentId: string; arkVersion: string },
      ) {
        return requiredFirst<PersonalAgentRecord>(
          db,
          sql`update personal_agents
                set ark_agent_id = ${upstream.arkAgentId},
                    ark_version = ${upstream.arkVersion},
                    status = 'failed',
                    last_error_code = 'DB_PERSISTENCE_FAILED',
                    updated_at = now()
              where id = ${id} and owner_user_id = ${userId}
              returning ${personalAgentSelection}`,
        );
      },
      markUpdatePersistenceFailure(
        id: string,
        userId: string,
        upstreamVersion: string,
      ) {
        return requiredFirst<PersonalAgentRecord>(
          db,
          sql`update personal_agents
                set ark_version = ${upstreamVersion},
                    status = 'failed',
                    last_error_code = 'DB_PERSISTENCE_FAILED',
                    updated_at = now()
              where id = ${id} and owner_user_id = ${userId}
              returning ${personalAgentSelection}`,
        );
      },
      async saveUpdateIntent(
        id: string,
        userId: string,
        configuration: {
          name: string;
          description: string;
          modelId: string;
          systemPrompt: string;
          skills?: AgentSkillBinding[];
        },
        arkVersion: string,
      ) {
        await enqueuePersonalAgentReconciliation(db, {
          id,
          ownerUserId: userId,
          payload: {
            operation: "update",
            personalAgentId: id,
            configuration,
            arkVersion,
          },
        });
      },
      update(
        id: string,
        userId: string,
        input: {
          name?: string;
          description?: string;
          modelId?: string;
          systemPrompt?: string;
          arkVersion?: string;
          status?: string;
          lastErrorCode?: string | null;
        },
      ) {
        return requiredFirst<PersonalAgentRecord>(
          db,
          sql`update personal_agents
                set name = coalesce(${input.name ?? null}, name),
                    description = coalesce(${input.description ?? null}, description),
                    model_id = coalesce(${input.modelId ?? null}, model_id),
                    system_prompt = coalesce(${input.systemPrompt ?? null}, system_prompt),
                    ark_version = coalesce(${input.arkVersion ?? null}, ark_version),
                    status = coalesce(${input.status ?? null}, status::text)::agent_status,
                    last_error_code = case
                      when ${input.lastErrorCode === null} then null
                      else coalesce(${input.lastErrorCode ?? null}, last_error_code)
                    end,
                    updated_at = now()
              where id = ${id} and owner_user_id = ${userId}
              returning ${personalAgentSelection}`,
        );
      },
      beginDelete(id: string, userId: string, enqueueReconciliation = true) {
        return db.transaction(async (transaction) => {
          const current = await first<PersonalAgentRecord>(
            transaction,
            sql`select ${personalAgentSelection}
                  from personal_agents
                 where id = ${id} and owner_user_id = ${userId}
                 for update`,
          );
          if (!current) return undefined;
          const createJob = await first<{
            status: string;
            payload: Record<string, unknown>;
          }>(
            transaction,
            sql`select status, payload
                  from background_jobs
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and type = 'reconcile_personal_agent'
                 limit 1`,
          );
          const createJobPending =
            createJob?.payload.operation === "create" &&
            (createJob.status === "pending" || createJob.status === "running");
          const pendingIdentity =
            current.arkAgentId.startsWith("pending:") &&
            current.status !== "failed";
          if (
            current.status === "provisioning" ||
            pendingIdentity ||
            createJobPending
          ) {
            return {
              agent: current,
              conflict: "create_reconciliation_pending" as const,
            };
          }
          const references = (await first<{ sessions: number }>(
            transaction,
            sql`select count(*)::integer as sessions
                  from sessions
                 where owner_user_id = ${userId}
                   and personal_agent_id = ${id}`,
          )) ?? { sessions: 0 };
          if (references.sessions > 0) {
            return {
              agent: current,
              previousStatus: current.status,
              references,
            };
          }
          const agent = await requiredFirst<PersonalAgentRecord>(
            transaction,
            sql`update personal_agents
                  set status = 'deleting', updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                returning ${personalAgentSelection}`,
          );
          if (enqueueReconciliation) {
            await enqueuePersonalAgentReconciliation(transaction, {
              id,
              ownerUserId: userId,
              payload: {
                operation: "delete",
                personalAgentId: id,
              },
            });
          }
          return {
            agent,
            previousStatus: current.status,
            references,
          };
        });
      },
      async remove(id: string, userId: string) {
        await db.transaction(async (transaction) => {
          await transaction.execute(
            sql`delete from background_jobs
                 where id = ${id} and owner_user_id = ${userId}
                   and type = 'reconcile_personal_agent'`,
          );
          await transaction.execute(
            sql`delete from personal_agents
                 where id = ${id} and owner_user_id = ${userId}`,
          );
        });
      },
      async audit(input: {
        actorUserId: string;
        ownerUserId: string;
        action: string;
        resourceType: "personal_agent";
        resourceId: string;
        result: "succeeded" | "failed";
        requestId: string;
        arkRequestId?: string;
        errorCode?: string;
      }) {
        await db.execute(
          sql`insert into audit_logs
                (id, actor_user_id, owner_user_id, action, resource_type,
                 resource_id, result, request_id, ark_request_id, error_code)
              values
                (${randomUUID()}, ${input.actorUserId}, ${input.ownerUserId},
                 ${input.action}, ${input.resourceType}, ${input.resourceId},
                 ${input.result}, ${input.requestId},
                 ${input.arkRequestId ?? null}, ${input.errorCode ?? null})`,
        );
      },
    },

    skills: {
      findOwned(userId: string, id: string) {
        return first<SkillRecord>(
          db,
          sql`select ${skillSelection}
                from skills
               where id = ${id}
                 and owner_user_id = ${userId}
               limit 1`,
        );
      },
      findPlatform(id: string) {
        return first<SkillRecord>(
          db,
          sql`select ${skillSelection}
                from skills
               where id = ${id}
                 and owner_user_id is null
               limit 1`,
        );
      },
      listForOwner(userId: string, search: string | null) {
        return rows<SkillRecord>(
          db,
          sql`select ${skillSelection}
                from skills
               where owner_user_id = ${userId}
                 ${search ? sql`and display_title ilike ${`%${search}%`}` : sql``}
               order by created_at desc, id asc`,
        );
      },
      listPlatform(search: string | null) {
        return rows<SkillRecord>(
          db,
          sql`select ${skillSelection}
                from skills
               where owner_user_id is null
                 ${search ? sql`and display_title ilike ${`%${search}%`}` : sql``}
               order by created_at desc, id asc`,
        );
      },
      listActiveBindingsForOwner(userId: string) {
        // Ark rejects an Agent whose Skills contain the same SKILL.md name
        // twice, so a library that re-uploads a package keeps only its newest
        // active version per name.
        return rows<AgentSkillBinding>(
          db,
          sql`select t."skillId", t."arkSkillId", t."arkVersion"
                from (
                  select distinct on (name)
                         id::text as "skillId",
                         ark_skill_id as "arkSkillId",
                         latest_version as "arkVersion"
                    from skills
                   where owner_user_id = ${userId}
                     and status = 'active'
                   order by name, updated_at desc, id desc
                ) t
               order by t."skillId" asc`,
        );
      },
      findActiveByName(
        ownerUserId: string | null,
        name: string,
        excludeId: string,
      ) {
        return first<SkillRecord>(
          db,
          sql`select ${skillSelection}
                from skills
               where owner_user_id is not distinct from ${ownerUserId}::uuid
                 and name = ${name}
                 and status = 'active'
                 and id <> ${excludeId}::uuid
               order by updated_at desc
               limit 1`,
        );
      },
      async findSelectableBindings(userId: string, skillIds: string[]) {
        return rows<AgentSkillBinding>(
          db,
          sql`select id::text as "skillId", ark_skill_id as "arkSkillId",
                     latest_version as "arkVersion"
                from skills
               where status = 'active'
                 and (owner_user_id = ${userId} or owner_user_id is null)
                 and id in (${sql.join(
                   skillIds.map((id) => sql`${id}::uuid`),
                   sql`, `,
                 )})
               order by id asc`,
        );
      },
      async createProvisioning(input: {
        id: string;
        ownerUserId: string | null;
        displayTitle: string;
        description: string;
        fileName: string;
        fileSize: number;
      }) {
        return requiredFirst<SkillRecord>(
          db,
          sql`insert into skills
                (id, owner_user_id, ark_skill_id, display_title, description,
                 file_name, file_size, latest_version, status)
              values
                (${input.id}, ${input.ownerUserId}, ${`pending:${input.id}`},
                 ${input.displayTitle}, ${input.description},
                 ${input.fileName}, ${input.fileSize}, '0', 'provisioning')
              returning ${skillSelection}`,
        );
      },
      markProvisioned(
        id: string,
        upstream: {
          arkSkillId: string;
          name: string;
          latestVersion: string;
          source: "custom" | "skill_hub";
        },
      ) {
        return requiredFirst<SkillRecord>(
          db,
          sql`update skills
                 set ark_skill_id = ${upstream.arkSkillId},
                     name = ${upstream.name},
                     latest_version = ${upstream.latestVersion},
                     source = ${upstream.source},
                     status = 'active',
                     last_error_code = null,
                     updated_at = now()
               where id = ${id}
               returning ${skillSelection}`,
        );
      },
      markFailure(
        id: string,
        status: "provisioning" | "failed" | "deleting",
        errorCode: string,
      ) {
        return requiredFirst<SkillRecord>(
          db,
          sql`update skills
                 set status = ${status},
                     last_error_code = ${errorCode},
                     updated_at = now()
               where id = ${id}
               returning ${skillSelection}`,
        );
      },
      updateMetadata(
        id: string,
        input: { displayTitle?: string; description?: string },
      ) {
        return requiredFirst<SkillRecord>(
          db,
          sql`update skills
                 set display_title = coalesce(${input.displayTitle ?? null}, display_title),
                     description = coalesce(${input.description ?? null}, description),
                     updated_at = now()
               where id = ${id}
               returning ${skillSelection}`,
        );
      },
      replaceUpstream(
        id: string,
        upstream: {
          arkSkillId: string;
          name: string;
          latestVersion: string;
          source: "custom" | "skill_hub";
        },
        file: { fileName: string; fileSize: number },
      ) {
        return requiredFirst<SkillRecord>(
          db,
          sql`update skills
                 set ark_skill_id = ${upstream.arkSkillId},
                     name = ${upstream.name},
                     latest_version = ${upstream.latestVersion},
                     source = ${upstream.source},
                     file_name = ${file.fileName},
                     file_size = ${file.fileSize},
                     status = 'active',
                     last_error_code = null,
                     updated_at = now()
               where id = ${id}
               returning ${skillSelection}`,
        );
      },
      async remove(id: string) {
        await db.execute(sql`delete from skills where id = ${id}`);
      },
      async audit(input: {
        actorUserId: string;
        ownerUserId: string | null;
        action: string;
        resourceType: "skill";
        resourceId: string;
        result: "succeeded" | "failed";
        requestId: string;
        arkRequestId?: string;
        errorCode?: string;
      }) {
        await db.execute(
          sql`insert into audit_logs
                (id, actor_user_id, owner_user_id, action, resource_type,
                 resource_id, result, request_id, ark_request_id, error_code)
              values
                (${randomUUID()}, ${input.actorUserId}, ${input.ownerUserId},
                 ${input.action}, ${input.resourceType}, ${input.resourceId},
                 ${input.result}, ${input.requestId},
                 ${input.arkRequestId ?? null}, ${input.errorCode ?? null})`,
        );
      },
    },

    adminAgents: {
      listUserAgents() {
        return rows<AdminUserAgentRecord>(
          db,
          sql`select pa.id, pa.name, pa.description,
                     pa.model_id as "modelId",
                     pa.ark_version as "arkVersion", pa.status,
                     pa.is_auto_default as "isAutoDefault",
                     pa.owner_user_id as "ownerUserId",
                     u.email as "ownerEmail",
                     ${agentSkillSummariesFor("pa")} as skills,
                     pa.created_at as "createdAt",
                     pa.updated_at as "updatedAt"
                from personal_agents pa
                join users u on u.id = pa.owner_user_id
               order by pa.is_auto_default desc, pa.created_at desc, pa.id asc`,
        );
      },
    },
    sessionDeletion: {
      findDeleting(userId: string, id: string) {
        return first<{
          id: string;
          ownerUserId: string;
          arkSessionId: string;
          status: SessionRecord["status"];
          createAttemptedAt: Date | null;
        }>(
          db,
          sql`select id, owner_user_id as "ownerUserId",
                     ark_session_id as "arkSessionId", status, create_attempted_at as "createAttemptedAt"
                from sessions
               where id = ${id}
                 and owner_user_id = ${userId}
                 and deletion_state in ('pending', 'deletion_failed')
               limit 1`,
        );
      },
      /**
       * Bytes outlive the Session row, so deletion cannot simply drop them.
       * This marks every drive file that only this Session referenced as
       * orphaned; the drive GC then reaps them according to the retention
       * setting (immediately at the default of zero). Runs before the Session
       * row is removed, while the associations still identify the files.
       */
      async orphanDriveFiles(userId: string, id: string, at: Date) {
        const orphaned = await rows(
          db,
          sql`update drive_files drive
                 set orphaned_at = coalesce(drive.orphaned_at, ${at}),
                     updated_at = ${at}
                from artifacts association
               where association.drive_file_id = drive.id
                 and association.session_id = ${id}
                 and association.owner_user_id = ${userId}
                 and drive.owner_user_id = ${userId}
                 and drive.deletion_state = 'none'
                 and not exists (
                   select 1
                     from artifacts other
                    where other.drive_file_id = drive.id
                      and other.session_id <> ${id}
                 )
                 and not exists(select 1 from session_inputs ref where ref.drive_file_id=drive.id
                   and ref.owner_user_id=${userId} and ref.session_id is distinct from ${id}::uuid)
              returning drive.id`,
        );
        return orphaned.length;
      },
      async removeLocal(userId: string, id: string) {
        return db.transaction(async (transaction) => {
          // Job-before-session lock order matches delivery admission/acknowledgement.
          await rows(
            transaction,
            sql`select id from background_jobs where owner_user_id=${userId} and payload->>'operation'='deliver' and payload->>'sessionId'=${id} for update`,
          );
          const session = await first<{
            id: string;
            arkSessionId: string;
            createAttemptedAt: Date | null;
          }>(
            transaction,
            sql`select id,ark_session_id as "arkSessionId",create_attempted_at as "createAttemptedAt"
                  from sessions
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and deletion_state in ('pending', 'deletion_failed')
                 for update`,
          );
          if (!session) return "missing" as const;
          const localOnly =
            session.arkSessionId.startsWith("pending:") &&
            session.createAttemptedAt === null;
          if (session.arkSessionId.startsWith("pending:") && !localOnly)
            return "cleanup_pending" as const;
          await transaction.execute(
            sql`update background_jobs set status='succeeded',locked_at=null,locked_by=null,last_error='SESSION_DELETED',updated_at=now() where owner_user_id=${userId} and payload->>'operation'='deliver' and payload->>'sessionId'=${id} and status in ('pending','running')`,
          );
          if (localOnly)
            await transaction.execute(
              sql`update quota_reservations set status='released',resolved_at=now() where id=${id} and user_id=${userId} and status in ('active','unknown_outcome')`,
            );
          await transaction.execute(
            sql`update quota_reservations
                   set status = 'unknown_outcome',
                       resolved_at = null
                 where id = ${id}
                   and user_id = ${userId}
                   and status = 'active'`,
          );
          // Capture only references removed by this deletion. Unrelated syncs
          // may have committed their drive bytes but not their association yet.
          const affected = await rows<{ id: string }>(
            transaction,
            sql`select d.id from drive_files d where d.owner_user_id=${userId}
              and (d.source_session_id=${id}
                or exists(select 1 from artifacts a where a.drive_file_id=d.id and a.session_id=${id})
                or exists(select 1 from session_inputs ref where ref.drive_file_id=d.id and ref.session_id=${id}))
              order by d.id for update`,
          );
          await transaction.execute(
            sql`delete from sessions
                 where id = ${id} and owner_user_id = ${userId}`,
          );
          for (const drive of affected)
            await transaction.execute(sql`update drive_files d set orphaned_at=coalesce(orphaned_at,now())
              where id=${drive.id} and owner_user_id=${userId} and deletion_state='none' and not exists(
                select 1 from session_inputs ref where ref.drive_file_id=d.id)
              and not exists(select 1 from artifacts a where a.drive_file_id=d.id and a.deletion_state='none')`);
          return "removed" as const;
        });
      },
    },
    sessions: tenantRepository(db, sql.raw("sessions")),
    sessionLifecycle: {
      findSubmission(userId: string, submissionId: string) {
        return first<SubmissionRow>(
          db,
          sql`select ${submissionSelection} from message_submissions where owner_user_id=${userId} and submission_id=${submissionId}`,
        );
      },
      async enqueueSubmission(input: {
        id: string;
        ownerUserId: string;
        sessionId: string;
        submissionId: string;
        requestHash: string;
        content: string;
        temporary: boolean;
        intent?: SessionRecordData;
        uploadIds?: string[];
      }): Promise<SubmissionRow> {
        return db.transaction(async (transaction) => {
          const owner = await first(
            transaction,
            sql`select id from users where id=${input.ownerUserId} and role='user' and status='active' for update`,
          );
          if (!owner)
            throw Object.assign(new Error("Resource not found"), {
              name: "ResourceNotFoundError",
            });
          const existing = await first<SubmissionRow>(
            transaction,
            sql`select ${submissionSelection} from message_submissions where owner_user_id=${input.ownerUserId} and submission_id=${input.submissionId}`,
          );
          if (existing) {
            if (existing.requestHash !== input.requestHash)
              throw Object.assign(
                new Error("Submission ID was already used for another request"),
                { code: "SUBMISSION_CONFLICT" },
              );
            return existing;
          }
          const lifecycle = createRepositories(transaction).sessionLifecycle;
          if (input.intent) {
            await lifecycle.prepareCreate(input.intent, input.uploadIds);
            // The delivery job owns creation. Retain the existing reservation/job
            // identity for completeCreate and deletion without a competing worker.
            await transaction.execute(
              sql`update background_jobs set status='succeeded' where id=${input.sessionId}`,
            );
          }
          const prepared = await lifecycle.beginMessage(
            input.ownerUserId,
            input.sessionId,
            true,
          );
          if (!prepared)
            throw Object.assign(new Error("Session unavailable"), {
              name: "ResourceNotFoundError",
            });
          if (prepared.kind === "deletion_conflict")
            throw Object.assign(new Error("Session deletion pending"), {
              name: "SessionDeletionConflictError",
              deletionState: prepared.deletionState,
              code:
                prepared.deletionState === "pending"
                  ? "DELETION_PENDING"
                  : "DELETION_FAILED",
            });
          if (prepared.session.status === "terminated")
            throw Object.assign(new Error("Session terminated"), {
              name: "SessionTerminatedError",
            });
          const firstSubmission = await first<SubmissionRow>(
            transaction,
            sql`select ${submissionSelection} from message_submissions where session_id=${input.sessionId} order by sequence limit 1`,
          );
          const temporary = input.intent
            ? input.temporary
            : (firstSubmission?.temporary ?? input.temporary);
          if (!temporary) {
            const memory = createMemoryRepository(transaction);
            if (await memory.get(input.ownerUserId))
              await memory.gate(input.ownerUserId);
          }
          const submission = await requiredFirst<SubmissionRow>(
            transaction,
            sql`insert into message_submissions
            (id,owner_user_id,session_id,submission_id,request_hash,content,temporary)
            values (${input.id},${input.ownerUserId},${input.sessionId},${input.submissionId},${input.requestHash},${input.content},${temporary}) returning ${submissionSelection}`,
          );
          // The Run is the product-visible execution and shares the durable
          // submission transaction, so a replayed submission cannot create a
          // second one.
          const createdRun = await transaction.execute<{ id: string }>(
            sql`insert into runs
              (id,owner_user_id,conversation_id,trigger_kind,submission_id,status)
              values (gen_random_uuid(),${input.ownerUserId},${input.sessionId},'manual',${input.submissionId},'queued')
              on conflict (owner_user_id,submission_id) do nothing
              returning id`,
          );
          const run = createdRun.rows[0];
          if (run) {
            await appendAccountChange(transaction, {
              ownerUserId: input.ownerUserId,
              resourceType: "run",
              resourceId: run.id,
              revision: 1,
            });
          }
          await transaction.execute(sql`insert into background_jobs (id,owner_user_id,type,status,priority,payload,run_after)
            values (${input.id},${input.ownerUserId},'reconcile_session','pending',100,${JSON.stringify({ operation: "deliver", sessionId: input.sessionId })}::jsonb,now())`);
          return submission;
        });
      },
      async listSubmissions(
        userId: string,
        sessionId: string,
      ): Promise<SubmissionRow[]> {
        return rows<SubmissionRow>(
          db,
          sql`select ${submissionSelection}, (select payload->>'content' from session_events where session_id=message_submissions.session_id and event_id=message_submissions.upstream_event_id) as "acceptedContent" from message_submissions where owner_user_id=${userId} and session_id=${sessionId} order by sequence`,
        );
      },
      async claimSubmission(
        userId: string,
        id: string,
        workerId: string,
        generation: number,
      ): Promise<SubmissionRow | undefined> {
        return db.transaction(async (transaction) => {
          const job = await first(
            transaction,
            sql`select id from background_jobs where id=${id} and owner_user_id=${userId} and status='running' and locked_by=${workerId} and lease_generation=${generation} and locked_at > now() - interval '5 minutes' for update`,
          );
          if (!job) return undefined;
          const item = await first<SubmissionRow>(
            transaction,
            sql`select ${submissionSelection} from message_submissions where id=${id} and owner_user_id=${userId} for update`,
          );
          if (!item) return undefined;
          if (item.status === "sending") {
            return requiredFirst<SubmissionRow>(
              transaction,
              sql`update message_submissions set status='unknown',lease_generation=${generation},last_error_code='DELIVERY_LEASE_LOST',updated_at=now() where id=${id} returning ${submissionSelection}`,
            );
          }
          if (item.status === "unknown")
            return requiredFirst<SubmissionRow>(
              transaction,
              sql`update message_submissions set lease_generation=${generation} where id=${id} returning ${submissionSelection}`,
            );
          if (item.status !== "queued") return item;
          const earlier = await first(
            transaction,
            sql`select id from message_submissions where session_id=${item.sessionId} and sequence < ${item.sequence} and status in ('queued','sending','unknown') limit 1`,
          );
          if (earlier)
            throw Object.assign(new Error("Earlier submission pending"), {
              code: "SUBMISSION_WAITING",
            });
          return requiredFirst<SubmissionRow>(
            transaction,
            sql`update message_submissions set status='sending',lease_generation=${generation},updated_at=now() where id=${id} returning ${submissionSelection}`,
          );
        });
      },
      async validateSubmission(
        userId: string,
        id: string,
        workerId: string,
        generation: number,
      ): Promise<SessionRecord> {
        return db.transaction(async (transaction) => {
          const owner = await first(
            transaction,
            sql`select id from users where id=${userId} and status='active' and role='user' for update`,
          );
          if (!owner)
            throw Object.assign(new Error("Account unavailable"), {
              code: "ACCOUNT_DISABLED",
            });
          const item = await first<SubmissionRow>(
            transaction,
            sql`select ${submissionSelection} from message_submissions where id=${id} and owner_user_id=${userId} and status='sending' and lease_generation=${generation}`,
          );
          const job = await first(
            transaction,
            sql`select id from background_jobs where id=${id} and status='running' and locked_by=${workerId} and lease_generation=${generation} and locked_at > now()-interval '5 minutes'`,
          );
          if (!item || !job)
            throw Object.assign(new Error("Delivery lease lost"), {
              code: "DELIVERY_LEASE_LOST",
            });
          const session = await first<SessionRecord>(
            transaction,
            sql`select ${sessionSelection} from sessions where id=${item.sessionId} and owner_user_id=${userId} and deletion_state='none' and status <> 'terminated' for update`,
          );
          if (!session)
            throw Object.assign(new Error("Session unavailable"), {
              code: "SESSION_UNAVAILABLE",
            });
          if (session.memoryStoreId != null)
            await createMemoryRepository(transaction).gate(userId);
          const quota = await effectiveQuota(transaction, userId);
          const month = utcMonthWindow(new Date());
          const usage = await requiredFirst<{
            tokens: number;
            concurrent: number;
          }>(
            transaction,
            sql`select
            (select coalesce(sum(quantity),0)::bigint from usage_ledger where user_id=${userId} and metric_type in ('input_tokens','output_tokens') and recorded_at >= ${month.start} and recorded_at < ${month.end}) as tokens,
            (select count(*)::integer from sessions where owner_user_id=${userId} and status in ('running','rescheduled') and deletion_state <> 'deleted') as concurrent`,
          );
          if (
            quota.mode === "enforced" &&
            (usage.tokens >= quota.monthlyTokenLimit ||
              usage.concurrent > quota.concurrentSessionLimit)
          )
            throw Object.assign(new Error("Quota exceeded"), {
              code: "QUOTA_EXCEEDED",
            });
          return session;
        });
      },
      async attachSubmissionMemory(
        userId: string,
        sessionId: string,
        memoryStoreId: string,
      ): Promise<void> {
        await db.execute(
          sql`update sessions set memory_store_id=${memoryStoreId} where id=${sessionId} and owner_user_id=${userId} and ark_session_id like 'pending:%' and create_attempted_at is null and deletion_state='none'`,
        );
      },
      async resumeVerifiedCreateSubmission(
        userId: string,
        id: string,
        generation: number,
      ): Promise<boolean> {
        return db.transaction(async (transaction) => {
          // The job fences delivery; session-before-receipt matches deletion.
          const job = await first(
            transaction,
            sql`select id from background_jobs
            where id=${id} and owner_user_id=${userId} and type='reconcile_session'
              and payload->>'operation'='deliver' and status='succeeded'
              and locked_by is null and attempts < max_attempts for update`,
          );
          if (!job) return false;
          const owner = await first(
            transaction,
            sql`select id from users where id=${userId}
            and status='active' and role='user' for update`,
          );
          if (!owner) return false;
          const item = await first<SubmissionRow>(
            transaction,
            sql`select ${submissionSelection}
            from message_submissions where id=${id} and owner_user_id=${userId}
              and status='unknown' and lease_generation=${generation}
              and last_error_code='ARK_SESSION_CONFIG_SNAPSHOT_INCOMPLETE'
              and upstream_event_id is null and content is not null
              and retain_until > now()`,
          );
          if (!item) return false;
          const session = await first(
            transaction,
            sql`select id from sessions
            where id=${item.sessionId} and owner_user_id=${userId}
              and ark_session_id not like 'pending:%' and create_attempted_at is not null
              and config_snapshot_state='verified' and config_snapshot_error_code is null
              and deletion_state='none' and status <> 'terminated'
              and not exists(select 1 from message_submissions earlier
                where earlier.session_id=${item.sessionId} and earlier.sequence < ${item.sequence})
              and not exists(select 1 from session_events event where event.session_id=${item.sessionId}
                and event.source_type='user.message') for update`,
          );
          if (!session) return false;
          // Revalidate after acquiring the session. Do not wait on receipt
          // locks held by expiry/acknowledgement paths in the reverse order.
          const locked = await first(
            transaction,
            sql`select id from message_submissions
            where id=${id} and owner_user_id=${userId} and session_id=${item.sessionId}
              and status='unknown' and lease_generation=${generation}
              and last_error_code='ARK_SESSION_CONFIG_SNAPSHOT_INCOMPLETE'
              and upstream_event_id is null and content is not null and retain_until > now()
            for update skip locked`,
          );
          if (!locked) return false;
          await transaction.execute(sql`update message_submissions set status='queued',last_error_code=null,
            updated_at=now() where id=${id}`);
          await transaction.execute(sql`update background_jobs set status='pending',run_after=now(),last_error=null,
            updated_at=now() where id=${id}`);
          await transaction.execute(sql`update sessions set message_unknown_outcome=exists(
            select 1 from message_submissions other where other.session_id=${item.sessionId} and other.status='unknown'),
            updated_at=now() where id=${item.sessionId} and owner_user_id=${userId}`);
          return true;
        });
      },
      async finishSubmission(
        userId: string,
        id: string,
        generation: number,
        input: {
          status: "queued" | "accepted" | "unknown" | "failed";
          eventId?: string;
          errorCode?: string;
          event?: StoredSessionEventInput;
          workerId?: string;
        },
      ): Promise<boolean> {
        if (
          input.status === "accepted" &&
          (!input.event || input.event.eventId !== input.eventId)
        )
          return false;
        return db.transaction(async (transaction) => {
          if (input.workerId) {
            const lease = await first(
              transaction,
              sql`select id from background_jobs where id=${id} and status='running' and locked_by=${input.workerId} and lease_generation=${generation} and locked_at > now()-interval '5 minutes' for update`,
            );
            if (!lease) return false;
          }
          const item = await first<SubmissionRow>(
            transaction,
            sql`select ${submissionSelection} from message_submissions where id=${id} and owner_user_id=${userId} and status in ('sending','unknown') and lease_generation=${generation} for update`,
          );
          if (!item) return false;
          if (
            !input.workerId &&
            (item.status !== "unknown" || input.status !== "accepted")
          )
            return false;
          if (input.status === "accepted") {
            const body = input.event?.payload.content;
            if (
              input.event?.sourceType !== "user.message" ||
              typeof body !== "string" ||
              body.length === 0 ||
              (item.content !== null && body !== item.content)
            )
              return false;
          }
          if (input.event)
            await createRepositories(transaction).sessionLifecycle.appendEvents(
              userId,
              item.sessionId,
              [input.event],
            );
          if (input.status === "accepted") {
            // The original body was checked above before any display projection.
            // Restore it if history cached a sanitized version first.
            await transaction.execute(
              sql`update session_events set payload=payload || jsonb_build_object('content',${input.event!.payload.content}::text) where session_id=${item.sessionId} and event_id=${input.eventId!} and source_type='user.message' and (${item.content !== null} or payload->>'content' is null or payload->>'content'='')`,
            );
            const stored = await first(
              transaction,
              sql`select event_id from session_events where session_id=${item.sessionId} and event_id=${input.eventId!} and source_type='user.message' and jsonb_typeof(payload->'content')='string' and payload->>'content'=${input.event!.payload.content}::text`,
            );
            if (!stored) return false;
          }
          await transaction.execute(
            sql`update message_submissions set status=${input.status}, upstream_event_id=coalesce(${input.eventId ?? null},upstream_event_id), last_error_code=${input.errorCode ?? null}, content=case when ${input.status}='accepted' then null else content end,updated_at=now() where id=${id}`,
          );
          if (input.status === "accepted" || input.status === "failed")
            await createRepositories(
              transaction,
            ).sessionLifecycle.finishMessage(
              userId,
              item.sessionId,
              input.status === "accepted"
                ? "accepted_or_unknown"
                : "definite_failure",
            );
          if (input.status === "failed")
            await releaseUnattemptedDurableCreate(
              transaction,
              userId,
              item.sessionId,
            );
          if (input.status === "accepted")
            await transaction.execute(
              sql`update sessions set message_unknown_outcome=exists(select 1 from message_submissions where session_id=${item.sessionId} and status='unknown') where id=${item.sessionId}`,
            );
          if (input.status === "unknown")
            await transaction.execute(
              sql`update sessions set message_unknown_outcome=true where id=${item.sessionId} and owner_user_id=${userId}`,
            );
          return true;
        });
      },
      async rememberSubmissionReceipt(
        userId: string,
        id: string,
        generation: number,
        eventId: string,
      ): Promise<void> {
        await db.execute(
          sql`update message_submissions set upstream_event_id=${eventId} where id=${id} and owner_user_id=${userId} and lease_generation=${generation} and status in ('sending','unknown')`,
        );
      },
      async expireSubmissionBodies(): Promise<void> {
        await db.transaction(async (transaction) => {
          // Final-attempt crashes cannot be reclaimed by the generic job queue.
          // Convert their durable receipts before normal retention maintenance.
          const stranded = await rows<SubmissionRow>(
            transaction,
            sql`select ${submissionSelection} from message_submissions where status in ('queued','sending') and exists(select 1 from background_jobs job where job.id=message_submissions.id and (job.status='failed' or (job.status='running' and job.attempts >= job.max_attempts and job.locked_at <= now()-interval '5 minutes'))) for update`,
          );
          for (const item of stranded) {
            await transaction.execute(
              sql`update message_submissions set status=${item.status === "sending" ? "unknown" : "failed"},last_error_code=${item.status === "sending" ? "DELIVERY_LEASE_LOST" : "DELIVERY_ATTEMPTS_EXHAUSTED"},updated_at=now() where id=${item.id}`,
            );
            if (item.status === "sending")
              await transaction.execute(
                sql`update sessions set message_unknown_outcome=true where id=${item.sessionId}`,
              );
            else {
              await createRepositories(
                transaction,
              ).sessionLifecycle.finishMessage(
                item.ownerUserId,
                item.sessionId,
                "definite_failure",
              );
              await releaseUnattemptedDurableCreate(
                transaction,
                item.ownerUserId,
                item.sessionId,
              );
            }
          }
          const expired = await rows<SubmissionRow>(
            transaction,
            sql`select ${submissionSelection} from message_submissions where content is not null and retain_until < now() for update`,
          );
          for (const item of expired) {
            if (item.status === "queued")
              await createRepositories(
                transaction,
              ).sessionLifecycle.finishMessage(
                item.ownerUserId,
                item.sessionId,
                "definite_failure",
              );
            await transaction.execute(
              sql`update message_submissions set content=null,status=case when status='queued' then 'failed' when status='sending' then 'unknown' else status end,last_error_code=coalesce(last_error_code,'SUBMISSION_BODY_EXPIRED'),updated_at=now() where id=${item.id}`,
            );
            if (item.status === "queued")
              await releaseUnattemptedDurableCreate(
                transaction,
                item.ownerUserId,
                item.sessionId,
              );
            if (item.status === "sending")
              await transaction.execute(
                sql`update sessions set message_unknown_outcome=true where id=${item.sessionId}`,
              );
          }
          await transaction.execute(
            sql`update message_submissions set content=null where content is not null and session_id in (select id from sessions where deletion_state <> 'none')`,
          );
        });
      },

      async prepareCreate(input: SessionRecordData, uploadIds: string[] = []) {
        const result = await db.transaction(async (transaction) => {
          const user = await first(
            transaction,
            sql`select id from users
                 where id = ${input.ownerUserId}
                   and role = 'user'
                   and status = 'active'
                 for update`,
          );
          if (!user) throw new Error("Active user not found");

          if (input.memoryStoreId != null) {
            await createMemoryRepository(transaction).gate(input.ownerUserId);
          }

          const selectedUploadIds = [...new Set(uploadIds)];
          let selectedInputs: SessionInputRecord[] = [];
          if (selectedUploadIds.length > 0) {
            const uploadIdList = sql.join(
              selectedUploadIds.map((uploadId) => sql`${uploadId}`),
              sql`, `,
            );
            selectedInputs = await rows<SessionInputRecord>(
              transaction,
              sql`select ${sessionInputSelection}
                    from session_inputs
                   where owner_user_id = ${input.ownerUserId}
                     and id in (${uploadIdList})
                     and session_id is null
                     and status = 'uploaded'
                     and expires_at > ${input.createdAt}
                   for update`,
            );
            if (selectedInputs.length !== selectedUploadIds.length) {
              const error = new Error("Resource not found");
              error.name = "ResourceNotFoundError";
              throw error;
            }
            if (
              selectedInputs.reduce(
                (sum, item) => sum + Number(item.sizeBytes),
                0,
              ) >
              100 * 1024 * 1024
            )
              throw Object.assign(new Error("材料总量不能超过 100 MB"), {
                name: "UploadTooLargeError",
                code: "UPLOAD_TOTAL_TOO_LARGE",
              });
          }

          const quota = await effectiveQuota(transaction, input.ownerUserId);
          const month = utcMonthWindow(input.createdAt);
          const day = utcDayWindow(input.createdAt);
          await preserveExpiredCreateOutcomes(
            transaction,
            input.ownerUserId,
            input.createdAt,
          );
          const counters = await first<{
            dailyCreateIntents: number;
            monthlyTokens: number;
          }>(
            transaction,
            sql`select
                  (select count(*)::integer
                     from quota_reservations
                    where user_id = ${input.ownerUserId}
                      and status in ('active', 'unknown_outcome', 'consumed')
                      and created_at >= ${day.start}
                      and created_at < ${day.end})
                    as "dailyCreateIntents",
                  (select coalesce(sum(quantity), 0)::bigint
                     from usage_ledger
                    where user_id = ${input.ownerUserId}
                      and metric_type in ('input_tokens', 'output_tokens')
                      and recorded_at >= ${month.start}
                      and recorded_at < ${month.end})
                    as "monthlyTokens"`,
          );
          if (!counters) throw new Error("Unable to read quota counters");
          if (quota.mode === "enforced") {
            if (counters.dailyCreateIntents >= quota.dailySessionLimit) {
              return { quotaExceeded: "daily_sessions" as const };
            }
            if (counters.monthlyTokens >= quota.monthlyTokenLimit) {
              return { quotaExceeded: "monthly_tokens" as const };
            }
          }

          await transaction.execute(
            sql`insert into quota_reservations
                  (id, user_id, ark_session_id, expires_at, created_at)
                values
                  (${input.id}, ${input.ownerUserId}, ${input.arkSessionId},
                   ${new Date(input.createdAt.getTime() + 5 * 60_000)},
                   ${input.createdAt})`,
          );
          await transaction.execute(
            sql`insert into sessions
                  (id, owner_user_id, ark_session_id, agent_kind,
                   platform_agent_id, personal_agent_id, ark_agent_id,
                   agent_name, agent_version, environment_id, title, status,
                   memory_store_id,
                   archived_at, deletion_state, last_event_at, created_at,
                   updated_at)
                values
                  (${input.id}, ${input.ownerUserId}, ${input.arkSessionId},
                   ${input.agentKind}, ${input.platformAgentId},
                   ${input.personalAgentId}, ${input.arkAgentId},
                   ${input.agentName}, ${input.agentVersion},
                   ${input.environmentId}, ${input.title}, ${input.status},
                   ${input.memoryStoreId ?? null},
                   ${input.archivedAt}, ${input.deletionState},
                   ${input.lastEventAt}, ${input.createdAt}, ${input.updatedAt})`,
          );
          await transaction.execute(
            sql`insert into background_jobs
                  (id, owner_user_id, type, status, priority, payload,
                   attempts, run_after)
                values
                  (${input.id}, ${input.ownerUserId}, 'reconcile_session',
                   'pending', 100,
                   ${JSON.stringify({
                     operation: "create",
                     sessionId: input.id,
                   })}::jsonb,
                   0, now() + interval '30 seconds')`,
          );
          if (selectedUploadIds.length > 0) {
            const uploadIdList = sql.join(
              selectedUploadIds.map((uploadId) => sql`${uploadId}`),
              sql`, `,
            );
            await transaction.execute(
              sql`update session_inputs
                    set session_id = ${input.id}, updated_at = now()
                  where owner_user_id = ${input.ownerUserId}
                    and id in (${uploadIdList})`,
            );
          }
          return {
            selectedInputs:
              selectedInputs.length > 0
                ? selectedInputs.map((selected) => ({
                    ...selected,
                    sessionId: input.id,
                  }))
                : undefined,
          };
        });
        if ("quotaExceeded" in result) {
          throw new QuotaExceededError(result.quotaExceeded);
        }
        return result.selectedInputs;
      },
      async claimCreateAttempt(
        id: string,
        userId: string,
        attemptedAt: Date,
        deliveryFence?: {
          jobId: string;
          workerId: string;
          leaseGeneration: number;
        },
      ) {
        if (deliveryFence)
          return db.transaction(async (transaction) => {
            const reject = (code: string) =>
              Object.assign(new Error("Create admission rejected"), {
                code,
                createAdmissionRejected: true,
              });
            const owner = await first(
              transaction,
              sql`select id from users where id=${userId} and status='active' and role='user' for update`,
            );
            if (!owner) throw reject("ACCOUNT_DISABLED");
            const lease = await first(
              transaction,
              sql`select job.id from background_jobs job where job.id=${deliveryFence.jobId} and job.owner_user_id=${userId} and job.type='reconcile_session' and job.payload->>'operation'='deliver' and job.payload->>'sessionId'=${id} and job.status='running' and job.locked_by=${deliveryFence.workerId} and job.lease_generation=${deliveryFence.leaseGeneration} and job.locked_at > clock_timestamp()-interval '5 minutes' and exists(select 1 from message_submissions ms where ms.id=job.id and ms.session_id=${id} and ms.owner_user_id=${userId} and ms.status='sending' and ms.lease_generation=${deliveryFence.leaseGeneration}) for update`,
            );
            if (!lease) throw reject("DELIVERY_LEASE_LOST");
            const session = await first<{ createAttemptedAt: Date | null }>(
              transaction,
              sql`select create_attempted_at as "createAttemptedAt" from sessions where id=${id} and owner_user_id=${userId} and ark_session_id like 'pending:%' and deletion_state='none' and status <> 'terminated' for update`,
            );
            if (!session) throw reject("SESSION_UNAVAILABLE");
            if (session.createAttemptedAt !== null) return false;
            const admitted = await first(
              transaction,
              sql`update sessions set create_attempted_at=${attemptedAt},updated_at=now() where id=${id} and owner_user_id=${userId} and exists(select 1 from background_jobs where id=${deliveryFence.jobId} and status='running' and locked_by=${deliveryFence.workerId} and lease_generation=${deliveryFence.leaseGeneration} and locked_at > clock_timestamp()-interval '5 minutes') returning id`,
            );
            if (!admitted) throw reject("DELIVERY_LEASE_LOST");
            return true;
          });
        const claimed = await rows<{ id: string }>(
          db,
          sql`update sessions
                 set create_attempted_at = ${attemptedAt},
                     updated_at = now()
               where id = ${id}
                 and owner_user_id = ${userId}
                 and ark_session_id like 'pending:%'
                 and create_attempted_at is null
                 and deletion_state='none'
                 and exists(select 1 from users where id=${userId} and status='active' and role='user')
               returning id`,
        );
        return claimed.length === 1;
      },
      async releaseCreateAttempt(
        id: string,
        userId: string,
        attemptedAt: Date,
      ) {
        const released = await rows<{ id: string }>(
          db,
          sql`update sessions
                 set create_attempted_at = null,
                     updated_at = now()
               where id = ${id}
                 and owner_user_id = ${userId}
                 and ark_session_id like 'pending:%'
                 and create_attempted_at = ${attemptedAt}
               returning id`,
        );
        return released.length === 1;
      },
      async completeCreate(
        id: string,
        userId: string,
        upstream: {
          arkSessionId: string;
          status: SessionRecord["status"];
          modelId?: string | null;
          configSnapshot?: SessionConfigSnapshot;
        },
      ) {
        assertVerifiedArkSessionId(upstream.arkSessionId);
        return db.transaction(async (transaction) => {
          const job = await requiredFirst<{ status: string }>(
            transaction,
            sql`select status from background_jobs
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and type in ('reconcile_session','delete_session')
                 for update`,
          );
          if (job.status === "failed") {
            throw new Error("Session create reconciliation is terminal");
          }
          const reservation = await consumeReservationIdentity(transaction, {
            reservationId: id,
            arkSessionId: upstream.arkSessionId,
            userId,
          });
          if (!reservation) {
            throw new Error("Session create reservation cannot be consumed");
          }
          await assertSessionIdentityCanBeObserved(transaction, {
            sessionId: id,
            userId,
            arkSessionId: upstream.arkSessionId,
          });
          const session = await requiredFirst<SessionRecord>(
            transaction,
            sql`update sessions
                  set ark_session_id = ${upstream.arkSessionId},
                      status = case when status='terminated' or ${upstream.status}='terminated' then 'terminated'::session_status
                        when message_in_flight_count > 0 then 'running'::session_status else ${upstream.status}::session_status end,
                      model_id = ${upstream.modelId ?? null},
                      config_snapshot = ${
                        upstream.configSnapshot
                          ? sql`${JSON.stringify(upstream.configSnapshot)}::jsonb`
                          : null
                      },
                      config_snapshot_state = ${
                        upstream.configSnapshot ? "verified" : "unverified"
                      },
                      config_snapshot_error_code = null,
                      updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                returning ${sessionSelection}`,
          );
          await transaction.execute(
            sql`update session_inputs
                  set status = 'bound', last_error_code = null,
                      updated_at = now()
                where session_id = ${id}
                  and owner_user_id = ${userId}
                  and status = 'uploaded'`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'succeeded', locked_at = null,
                      locked_by = null, last_error = null, updated_at = now()
                where type = 'cleanup_upload'
                  and owner_user_id = ${userId}
                  and id in (
                    select id from session_inputs
                     where session_id = ${id}
                       and owner_user_id = ${userId}
                  )`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'succeeded', locked_at = null,
                      locked_by = null, last_error = null, updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                  and type = 'reconcile_session'`,
          );
          return session;
        });
      },
      async preserveCreateOutcome(
        id: string,
        userId: string,
        upstream?: {
          arkSessionId: string;
          status: SessionRecord["status"];
          modelId?: string | null;
          configSnapshot?: SessionConfigSnapshot;
          configSnapshotState?: "verified" | "incomplete" | "mismatch";
          configSnapshotErrorCode?: string | null;
        },
      ) {
        if (upstream) {
          assertVerifiedArkSessionId(upstream.arkSessionId);
        }
        await db.transaction(async (transaction) => {
          if (upstream) {
            const reservation = await consumeReservationIdentity(transaction, {
              reservationId: id,
              arkSessionId: upstream.arkSessionId,
              userId,
            });
            if (!reservation) {
              throw new Error("Session create reservation cannot be consumed");
            }
            await assertSessionIdentityCanBeObserved(transaction, {
              sessionId: id,
              userId,
              arkSessionId: upstream.arkSessionId,
            });
            if (upstream.configSnapshot && upstream.configSnapshotState) {
              await transaction.execute(
                sql`update sessions
                      set ark_session_id = ${upstream.arkSessionId},
                          status = case when status='terminated' or ${upstream.status}='terminated' then 'terminated'::session_status
                        when message_in_flight_count > 0 then 'running'::session_status else ${upstream.status}::session_status end,
                          model_id = ${upstream.modelId ?? null},
                          config_snapshot =
                            ${JSON.stringify(upstream.configSnapshot)}::jsonb,
                          config_snapshot_state =
                            ${upstream.configSnapshotState},
                          config_snapshot_error_code =
                            ${upstream.configSnapshotErrorCode},
                          updated_at = now()
                    where id = ${id} and owner_user_id = ${userId}`,
              );
            } else {
              await transaction.execute(
                sql`update sessions
                      set ark_session_id = ${upstream.arkSessionId},
                          status = case when status='terminated' then 'terminated'::session_status else ${upstream.status}::session_status end,
                          updated_at = now()
                    where id = ${id} and owner_user_id = ${userId}`,
              );
            }
          } else {
            await transaction.execute(
              sql`update quota_reservations
                    set status = 'unknown_outcome',
                        resolved_at = null
                  where id = ${id}
                    and user_id = ${userId}
                    and status = 'active'`,
            );
          }
        });
      },
      async failCreate(id: string, userId: string) {
        await db.transaction(async (transaction) => {
          await transaction.execute(
            sql`update quota_reservations
                  set status = 'released', resolved_at = now()
                where id = ${id} and user_id = ${userId}
                  and status in ('active', 'unknown_outcome')`,
          );
          await transaction.execute(
            sql`delete from sessions
                 where id = ${id} and owner_user_id = ${userId}`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'failed', locked_at = null, locked_by = null,
                      last_error = 'ARK_CREATE_FAILED', updated_at = now()
                where id = ${id} and owner_user_id = ${userId}
                  and type = 'reconcile_session'`,
          );
        });
      },
      listOwned(userId: string, archived: boolean) {
        return rows<SessionRecord>(
          db,
          sql`select ${sessionSelection}
                from sessions
               where owner_user_id = ${userId}
                 and (
                   ark_session_id not like 'pending:%'
                   or deletion_state = 'deletion_failed'
                   or exists (select 1 from message_submissions ms where ms.session_id=sessions.id)
                 )
                 and deletion_state <> 'deleted'
                 and ${
                   archived
                     ? sql`archived_at is not null`
                     : sql`archived_at is null`
                 }
               order by pinned_at desc nulls last, updated_at desc, id desc`,
        );
      },
      rename(userId: string, id: string, title: string) {
        return first<SessionRecord>(
          db,
          sql`update sessions
                 set title = ${title}, updated_at = now()
               where id = ${id}
                 and owner_user_id = ${userId}
                 and ark_session_id not like 'pending:%'
                 and deletion_state = 'none'
              returning ${sessionSelection}`,
        );
      },
      setPinned(userId: string, id: string, pinnedAt: Date | null) {
        return first<SessionRecord>(
          db,
          sql`update sessions
                 set pinned_at = ${pinnedAt}
               where id = ${id}
                 and owner_user_id = ${userId}
                 and ark_session_id not like 'pending:%'
                 and deletion_state = 'none'
              returning ${sessionSelection}`,
        );
      },
      ...createSessionEventRepository(db),
      findSettlementTarget(userId: string, id: string) {
        return first<{
          arkSessionId: string;
          messageInFlightCount: number;
          messageStartPending: boolean;
          messageUnknownOutcome: boolean;
        }>(
          db,
          sql`select ark_session_id as "arkSessionId",
                     message_in_flight_count as "messageInFlightCount",
                     message_start_pending as "messageStartPending",
                     message_unknown_outcome as "messageUnknownOutcome"
                from sessions
               where id = ${id} and owner_user_id = ${userId}
               limit 1`,
        );
      },
      async recordSettlement(
        userId: string,
        id: string,
        input: {
          state: "pending" | "confirmed" | "unknown";
          evidence: Record<string, unknown>;
          checkedAt: Date;
        },
      ) {
        await db.execute(
          sql`update sessions
                 set settlement_state = ${input.state}::settlement_state,
                     settlement_checked_at = ${input.checkedAt},
                     settlement_evidence = ${JSON.stringify(input.evidence)}::jsonb,
                     updated_at = now()
               where id = ${id} and owner_user_id = ${userId}`,
        );
      },
      findOwned(userId: string, id: string) {
        return first<SessionRecord>(
          db,
          sql`select ${sessionSelection}
                from sessions
               where id = ${id} and owner_user_id = ${userId}
                 and (
                   ark_session_id not like 'pending:%'
                   or deletion_state = 'deletion_failed'
                   or exists (select 1 from message_submissions ms where ms.session_id=sessions.id)
                 )
                 and deletion_state <> 'deleted'
               limit 1`,
        );
      },
      findCreateIntent(userId: string, id: string) {
        return first<SessionRecord>(
          db,
          sql`select ${sessionSelection}
                from sessions
               where id = ${id} and owner_user_id = ${userId}
               limit 1`,
        );
      },
      setArchived(userId: string, id: string, archivedAt: Date | null) {
        return first<SessionRecord>(
          db,
          sql`update sessions
                set archived_at = ${archivedAt}
              where id = ${id}
                and owner_user_id = ${userId}
                and ark_session_id not like 'pending:%'
                and deletion_state <> 'deleted'
              returning ${sessionSelection}`,
        );
      },
      beginDelete(userId: string, id: string) {
        return db.transaction(async (transaction) => {
          const job = await first<{
            type: JobRecord["type"];
            status: "pending" | "running" | "succeeded" | "failed";
          }>(
            transaction,
            sql`select type, status
                  from background_jobs
                 where id = ${id}
                   and owner_user_id = ${userId}
                 for update`,
          );
          const session = await first<SessionRecord>(
            transaction,
            sql`select ${sessionSelection}
                  from sessions
                 where id = ${id}
                  and owner_user_id = ${userId}
                  and (
                    ark_session_id not like 'pending:%'
                    or deletion_state = 'deletion_failed'
                   or exists (select 1 from message_submissions ms where ms.session_id=sessions.id)
                  )
                  and deletion_state <> 'deleted'
                 for update`,
          );
          if (!session) return undefined;

          if (job?.type === "delete_session" && job.status !== "failed") {
            return session;
          }
          if (job?.type === "delete_session") {
            await requiredFirst(
              transaction,
              sql`update background_jobs
                    set status = 'pending',
                        priority = 80,
                        attempts = 0,
                        run_after = now(),
                        locked_at = null,
                        locked_by = null,
                        last_error = null,
                        updated_at = now()
                  where id = ${id}
                    and owner_user_id = ${userId}
                    and type = 'delete_session'
                    and status = 'failed'
                  returning id`,
            );
          } else if (job?.type === "reconcile_session") {
            await requiredFirst(
              transaction,
              sql`update background_jobs
                    set type = 'delete_session',
                        status = 'pending',
                        priority = 80,
                        payload = ${JSON.stringify({
                          sessionId: id,
                          completed: {},
                        })}::jsonb,
                        attempts = 0,
                        run_after = now(),
                        locked_at = null,
                        locked_by = null,
                        last_error = null,
                        updated_at = now()
                  where id = ${id}
                    and owner_user_id = ${userId}
                    and type = 'reconcile_session'
                  returning id`,
            );
          } else if (!job) {
            await transaction.execute(
              sql`insert into background_jobs
                  (id, owner_user_id, type, status, priority, payload,
                   attempts, run_after)
                values
                  (${id}, ${userId}, 'delete_session', 'pending', 80,
                   ${JSON.stringify({ sessionId: id, completed: {} })}::jsonb,
                   0, now())`,
            );
          } else {
            throw new Error("Session deletion job conflicts with existing job");
          }

          await transaction.execute(
            sql`update message_submissions set content=null where session_id=${id} and owner_user_id=${userId}`,
          );
          return requiredFirst<SessionRecord>(
            transaction,
            sql`update sessions
                  set deletion_state = 'pending',
                      updated_at = now()
                where id = ${id}
                  and owner_user_id = ${userId}
                  and deletion_state <> 'deleted'
                returning ${sessionSelection}`,
          );
        });
      },
      listInputs(userId: string, id: string) {
        return rows<SessionInputRecord>(
          db,
          sql`select ${sessionInputSelection}
                from session_inputs
               where owner_user_id = ${userId}
                 and session_id = ${id}
               order by created_at asc, id asc`,
        );
      },
      beginMessage(userId: string, id: string, allowPending = false) {
        return db.transaction(async (transaction) => {
          const user = await first(
            transaction,
            sql`select id from users
                 where id = ${userId}
                   and role = 'user'
                   and status = 'active'
                 for update`,
          );
          if (!user) return undefined;
          const session = await first<SessionRecord>(
            transaction,
            sql`select ${sessionSelection}
                  from sessions
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and (${allowPending} or ark_session_id not like 'pending:%')
                   and deletion_state <> 'deleted'
                 for update`,
          );
          if (!session) return undefined;
          if (
            session.deletionState === "pending" ||
            session.deletionState === "deletion_failed"
          ) {
            return {
              kind: "deletion_conflict" as const,
              deletionState: session.deletionState,
            };
          }

          if (session.memoryStoreId != null) {
            await createMemoryRepository(transaction).gate(userId);
          }

          const quota = await effectiveQuota(transaction, userId);
          const month = utcMonthWindow(new Date());
          const usage = await first<{
            concurrentSessions: number;
            monthlyTokens: number;
          }>(
            transaction,
            sql`select
                  (select count(*)::integer
                     from sessions
                    where owner_user_id = ${userId}
                      and status in ('running', 'rescheduled')
                      and deletion_state <> 'deleted')
                    as "concurrentSessions",
                  (select coalesce(sum(quantity), 0)::bigint
                     from usage_ledger
                    where user_id = ${userId}
                      and metric_type in ('input_tokens', 'output_tokens')
                      and recorded_at >= ${month.start}
                      and recorded_at < ${month.end})
                    as "monthlyTokens"`,
          );
          if (!usage) throw new Error("Unable to read message quota");
          if (
            quota.mode === "enforced" &&
            usage.monthlyTokens >= quota.monthlyTokenLimit
          ) {
            throw new QuotaExceededError("monthly_tokens");
          }
          if (session.status !== "idle") {
            if (session.status === "terminated") {
              return {
                kind: "accepted" as const,
                session,
                started: false,
              };
            }
            const queued = await requiredFirst<SessionRecord>(
              transaction,
              sql`update sessions
                    set message_in_flight_count = message_in_flight_count + 1,
                        updated_at = now()
                  where id = ${id}
                    and owner_user_id = ${userId}
                    and status in ('running', 'rescheduled')
                    and deletion_state = 'none'
                  returning ${sessionSelection}`,
            );
            return {
              kind: "accepted" as const,
              session: queued,
              started: false,
            };
          }
          if (
            quota.mode === "enforced" &&
            usage.concurrentSessions >= quota.concurrentSessionLimit
          ) {
            throw new QuotaExceededError("concurrent_sessions");
          }

          const started = await requiredFirst<SessionRecord>(
            transaction,
            sql`update sessions
                  set status = 'running',
                      message_in_flight_count = message_in_flight_count + 1,
                      message_start_pending = true,
                      updated_at = now()
                where id = ${id}
                  and owner_user_id = ${userId}
                  and status = 'idle'
                  and deletion_state = 'none'
                returning ${sessionSelection}`,
          );
          return {
            kind: "accepted" as const,
            session: started,
            started: true,
          };
        });
      },
      async finishMessage(
        userId: string,
        id: string,
        outcome: "accepted_or_unknown" | "unknown" | "definite_failure",
      ) {
        await db.execute(
          sql`update sessions
                set status = case
                      when ${outcome} = 'definite_failure'
                        and message_start_pending
                        and message_in_flight_count = 1
                        and status = 'running'
                      then 'idle'::session_status
                      else status
                    end,
                    message_start_pending = case
                      when ${outcome} in ('accepted_or_unknown', 'unknown')
                        or message_in_flight_count = 1
                      then false
                      else message_start_pending
                    end,
                    message_unknown_outcome =
                      message_unknown_outcome or ${outcome} = 'unknown',
                    message_in_flight_count =
                      greatest(message_in_flight_count - 1, 0),
                    updated_at = now()
              where id = ${id}
                and owner_user_id = ${userId}
                and message_in_flight_count > 0`,
        );
      },
      async projectEvent(
        userId: string,
        id: string,
        projection: {
          eventId: string;
          observedAt: Date;
          status?: SessionRecord["status"];
          errorCode?: string | null;
          errorRecoverable?: boolean | null;
          metrics?: Array<{
            metricType: UsageMetricType;
            quantity: number;
          }>;
        },
        history?: { scanGeneration?: number; signal?: AbortSignal },
      ) {
        return db.transaction(async (transaction) => {
          history?.signal?.throwIfAborted();
          const owner = await first(
            transaction,
            sql`select id from users
                 where id = ${userId}
                 for update`,
          );
          history?.signal?.throwIfAborted();
          if (!owner) return false;
          const session = await first(
            transaction,
            sql`select id from sessions
                 where id = ${id} and owner_user_id = ${userId}
                   and deletion_state = 'none'
                 for update`,
          );
          history?.signal?.throwIfAborted();
          if (!session) return false;
          await transaction.execute(
            sql`insert into session_event_cursors
                  (session_id, recent_event_ids)
                select id, '[]'::jsonb
                  from sessions
                 where id = ${id} and owner_user_id = ${userId}
                on conflict (session_id) do nothing`,
          );
          history?.signal?.throwIfAborted();
          const cursor = await first<{
            lastObservedAt: Date | null;
            runningSince: Date | null;
            recentEventIds: string[];
            scanGeneration: number;
          }>(
            transaction,
            sql`select cursor.last_observed_at as "lastObservedAt",
                       cursor.running_since as "runningSince",
                       cursor.recent_event_ids as "recentEventIds",
                       cursor.history_scan_generation as "scanGeneration"
                  from session_event_cursors cursor
                  join sessions session on session.id = cursor.session_id
                 where cursor.session_id = ${id}
                   and session.owner_user_id = ${userId}
                 for update of cursor`,
          );
          history?.signal?.throwIfAborted();
          if (
            cursor &&
            history?.scanGeneration !== undefined &&
            cursor.scanGeneration !== history.scanGeneration
          )
            throw Object.assign(new Error("History scan was superseded"), {
              code: "EVENT_HISTORY_SCAN_STALE",
            });
          if (!cursor || cursor.recentEventIds.includes(projection.eventId)) {
            return false;
          }

          const lastObservedAt =
            cursor.lastObservedAt === null
              ? null
              : new Date(cursor.lastObservedAt);
          const runningSince =
            cursor.runningSince === null ? null : new Date(cursor.runningSince);
          const chronological =
            lastObservedAt === null || lastObservedAt <= projection.observedAt;
          const activeStatus = projection.status === "running";
          const closesRuntime =
            chronological &&
            projection.status !== undefined &&
            !activeStatus &&
            runningSince !== null &&
            runningSince <= projection.observedAt;
          const metrics = [
            ...(projection.metrics ?? []),
            ...(closesRuntime
              ? [
                  {
                    metricType: "runtime_ms" as const,
                    quantity:
                      projection.observedAt.getTime() - runningSince!.getTime(),
                  },
                ]
              : []),
          ];
          let tokenUsageInserted = false;
          // T03-B: model attribution comes from the Session's create-time
          // verified snapshot only. The Agent tables are deliberately not
          // joined — a later Agent model change must not drift an existing
          // Session's attribution. `exact` requires the verified state, a
          // stored model, and agreement with the safe snapshot's model.
          for (const metric of metrics) {
            const inserted = await rows(
              transaction,
              sql`insert into usage_ledger
                    (id, user_id, ark_session_id, ark_event_id, metric_type,
                     quantity, recorded_at, agent_kind, platform_agent_id,
                     personal_agent_id, model_id,
                     model_attribution_precision)
                  select ${randomUUID()}, ${userId}, session.ark_session_id,
                         ${projection.eventId}, ${metric.metricType},
                         ${metric.quantity}, ${projection.observedAt},
                         session.agent_kind, session.platform_agent_id,
                         session.personal_agent_id,
                         case
                           when session.config_snapshot_state = 'verified'
                                and session.model_id is not null
                                and session.config_snapshot ->> 'modelId'
                                      = session.model_id
                             then session.model_id
                           else null
                         end,
                         case
                           when session.config_snapshot_state = 'verified'
                                and session.model_id is not null
                                and session.config_snapshot ->> 'modelId'
                                      = session.model_id
                             then 'exact'::model_attribution_precision
                           else 'unknown'::model_attribution_precision
                         end
                    from sessions session
                   where session.id = ${id}
                     and session.owner_user_id = ${userId}
                  on conflict
                    (user_id, ark_session_id, ark_event_id, metric_type)
                  do nothing
                  returning id`,
            );
            if (
              inserted.length === 1 &&
              (metric.metricType === "input_tokens" ||
                metric.metricType === "output_tokens")
            ) {
              tokenUsageInserted = true;
            }
          }
          if (tokenUsageInserted) {
            const window = utcMonthWindow(projection.observedAt);
            const quota = await effectiveQuota(transaction, userId);
            const usage = await first<{ total: number }>(
              transaction,
              sql`select coalesce(sum(quantity), 0)::bigint as total
                    from usage_ledger
                   where user_id = ${userId}
                     and metric_type in ('input_tokens', 'output_tokens')
                     and recorded_at >= ${window.start}
                     and recorded_at < ${window.end}`,
            );
            if (
              quota.mode === "enforced" &&
              Number(usage?.total ?? 0) >= quota.monthlyTokenLimit
            ) {
              await enqueueQuotaInterrupts(
                transaction,
                userId,
                window.start,
                projection.observedAt,
              );
            }
          }

          const nextRunningSince =
            chronological && projection.status !== undefined
              ? activeStatus
                ? (runningSince ?? projection.observedAt)
                : null
              : runningSince;
          await transaction.execute(
            sql`update session_event_cursors
                  set recent_event_ids = case
                        when jsonb_array_length(recent_event_ids) >= 256
                          then (recent_event_ids - 0)
                               || jsonb_build_array(${projection.eventId}::text)
                        else recent_event_ids
                             || jsonb_build_array(${projection.eventId}::text)
                      end,
                      last_observed_at = greatest(
                        coalesce(last_observed_at, ${projection.observedAt}),
                        ${projection.observedAt}
                      ),
                      running_since = ${nextRunningSince},
                      updated_at = now()
                where session_id = ${id}`,
          );

          const applies =
            projection.status !== undefined ||
            projection.errorCode !== undefined ||
            projection.errorRecoverable !== undefined;
          await transaction.execute(
            sql`update sessions
                  set status = case
                        when ${applies}
                          and (
                            last_event_at is null
                            or last_event_at <= ${projection.observedAt}
                          )
                          and ${projection.status !== undefined}
                          and not (${projection.status === "idle"} and exists(select 1 from message_submissions ms where ms.session_id=sessions.id and ms.status in ('queued','sending','unknown')))
                        then ${projection.status ?? null}::session_status
                        else status
                      end,
                      last_error_code = case
                        when ${applies}
                          and (
                            last_event_at is null
                            or last_event_at <= ${projection.observedAt}
                          )
                          and ${projection.errorCode !== undefined}
                        then ${projection.errorCode ?? null}
                        else last_error_code
                      end,
                      error_recoverable = case
                        when ${applies}
                          and (
                            last_event_at is null
                            or last_event_at <= ${projection.observedAt}
                          )
                          and ${projection.errorRecoverable !== undefined}
                        then ${projection.errorRecoverable ?? null}
                        else error_recoverable
                      end,
                      last_event_at = greatest(
                        coalesce(last_event_at, ${projection.observedAt}),
                        ${projection.observedAt}
                      ),
                      updated_at = now()
                where id = ${id} and owner_user_id = ${userId}`,
          );

          history?.signal?.throwIfAborted();
          return tokenUsageInserted;
        });
      },
      listRunningForQuota(userId: string) {
        return rows<SessionRecord>(
          db,
          sql`select ${sessionSelection}
                from sessions
               where owner_user_id = ${userId}
                 and status in ('running', 'rescheduled')
                 and deletion_state = 'none'
               order by updated_at, id`,
        );
      },
      async syncQuotaStatus(
        userId: string,
        id: string,
        status: SessionRecord["status"],
        observedAt: Date,
      ) {
        await db.execute(
          sql`update sessions
                set status = ${status},
                    updated_at = ${observedAt}
              where id = ${id}
                and owner_user_id = ${userId}
                and status in ('running', 'rescheduled')
                and deletion_state = 'none'
                and not (${status === "idle"} and exists(select 1 from message_submissions ms where ms.session_id=sessions.id and ms.status in ('queued','sending','unknown')))`,
        );
      },
      async audit(input: {
        actorUserId: string;
        ownerUserId: string;
        action: string;
        resourceType: "session";
        resourceId: string;
        result: "succeeded" | "failed";
        requestId: string;
        arkRequestId?: string;
        errorCode?: string;
      }) {
        await db.execute(
          sql`insert into audit_logs
                (id, actor_user_id, owner_user_id, action, resource_type,
                 resource_id, result, request_id, ark_request_id, error_code)
              values
                (${randomUUID()}, ${input.actorUserId}, ${input.ownerUserId},
                 ${input.action}, ${input.resourceType}, ${input.resourceId},
                 ${input.result}, ${input.requestId},
                 ${input.arkRequestId ?? null}, ${input.errorCode ?? null})`,
        );
      },
    },
    sessionInputs: {
      prepareUpload(input: SessionInputRecord) {
        return db.transaction(async (transaction) => {
          await transaction.execute(
            sql`insert into session_inputs
                  (id, owner_user_id, session_id, ark_file_id, original_name,
                   mime_type, size_bytes, mount_path, status, expires_at,
                   last_error_code, created_at, updated_at)
                values
                  (${input.id}, ${input.ownerUserId}, ${input.sessionId},
                   ${input.arkFileId}, ${input.originalName}, ${input.mimeType},
                   ${input.sizeBytes}, ${input.mountPath}, ${input.status},
                   ${input.expiresAt}, ${input.lastErrorCode},
                   ${input.createdAt}, ${input.updatedAt})`,
          );
          await transaction.execute(
            sql`insert into background_jobs
                  (id, owner_user_id, type, status, priority, payload,
                   attempts, run_after)
                values
                  (${input.id}, ${input.ownerUserId}, 'cleanup_upload',
                   'pending', 200,
                   ${JSON.stringify({ uploadId: input.id })}::jsonb,
                   0, ${input.expiresAt})`,
          );
        });
      },
      completeUpload(
        id: string,
        userId: string,
        upstream: {
          arkFileId: string;
          mimeType: string;
          sizeBytes: number;
        },
      ) {
        return requiredFirst<SessionInputRecord>(
          db,
          sql`update session_inputs
                set ark_file_id = ${upstream.arkFileId},
                    mime_type = ${upstream.mimeType},
                    size_bytes = ${upstream.sizeBytes},
                    status = 'uploaded',
                    last_error_code = null,
                    updated_at = now()
              where id = ${id}
                and owner_user_id = ${userId}
                and session_id is null
                and status = 'uploading'
              returning ${sessionInputSelection}`,
        );
      },
      async preserveUploadOutcome(
        id: string,
        userId: string,
        upstream: {
          arkFileId: string;
          mimeType: string;
          sizeBytes: number;
        },
      ) {
        await db.execute(
          sql`update session_inputs
                set ark_file_id = ${upstream.arkFileId},
                    mime_type = ${upstream.mimeType},
                    size_bytes = ${upstream.sizeBytes},
                    status = 'uploaded',
                    last_error_code = 'DB_PERSISTENCE_FAILED',
                    updated_at = now()
              where id = ${id}
                and owner_user_id = ${userId}
                and session_id is null
                and status = 'uploading'`,
        );
      },
      async failUpload(id: string, userId: string, errorCode: string) {
        await db.transaction(async (transaction) => {
          await transaction.execute(
            sql`update session_inputs
                  set status = 'failed', last_error_code = ${errorCode},
                      updated_at = now()
                where id = ${id}
                  and owner_user_id = ${userId}
                  and session_id is null`,
          );
          await transaction.execute(
            sql`update background_jobs
                  set status = 'pending', locked_at = null, locked_by = null,
                      last_error = ${errorCode}, updated_at = now()
                where id = ${id}
                  and owner_user_id = ${userId}
                  and type = 'cleanup_upload'`,
          );
        });
      },
      findOwned(userId: string, id: string) {
        return first<SessionInputRecord>(
          db,
          sql`select ${sessionInputSelection}
                from session_inputs
               where id = ${id} and owner_user_id = ${userId}
               limit 1`,
        );
      },
      findExpiredUnbound(userId: string, id: string, now = new Date()) {
        return first<SessionInputRecord>(
          db,
          sql`update session_inputs
                set status = 'deleting', updated_at = ${now}
              where id = ${id}
                and owner_user_id = ${userId}
                and session_id is null
                and status in ('uploading', 'uploaded', 'failed', 'deleting')
                and expires_at <= ${now}
              returning ${sessionInputSelection}`,
        );
      },
      async removeUnbound(id: string, userId: string) {
        return db.transaction(async (transaction) => {
          const source = await first<{ driveId: string | null }>(
            transaction,
            sql`select drive_file_id as "driveId" from session_inputs
          where id=${id} and owner_user_id=${userId} and session_id is null`,
          );
          if (source?.driveId)
            await transaction.execute(sql`update drive_files set orphaned_at=coalesce(orphaned_at,now())
          where id=${source.driveId} and owner_user_id=${userId}
          and not exists(select 1 from artifacts a where a.drive_file_id=drive_files.id and a.deletion_state='none')
          and not exists(select 1 from session_inputs other where other.drive_file_id=drive_files.id and other.id<>${id})`);
          const removed = await rows(
            transaction,
            sql`delete from session_inputs
                where id = ${id}
                  and owner_user_id = ${userId}
                  and session_id is null
                returning id`,
          );
          return removed.length === 1;
        });
      },
    },
    artifacts: {
      findSessionOwned(userId: string, sessionId: string) {
        return first<{ id: string; arkSessionId: string }>(
          db,
          sql`select id, ark_session_id as "arkSessionId"
                from sessions
               where id = ${sessionId}
                 and owner_user_id = ${userId}
                 and ark_session_id not like 'pending:%'
                 and deletion_state = 'none'
               limit 1`,
        );
      },
      async listInputFileIds(userId: string, sessionId: string) {
        const records = await rows<{ arkFileId: string }>(
          db,
          sql`select ark_file_id as "arkFileId"
                from session_inputs
               where session_id = ${sessionId}
                 and owner_user_id = ${userId}
                 and ark_file_id is not null`,
        );
        return records.map((record) => record.arkFileId);
      },
      findBySource(userId: string, sessionId: string, arkFileId: string) {
        return first<ArtifactRecord & Row>(
          db,
          sql`select ${artifactSelection}
                from artifacts
               where artifacts.owner_user_id = ${userId}
                 and artifacts.session_id = ${sessionId}
                 and artifacts.ark_file_id = ${arkFileId}
               limit 1`,
        );
      },
      /**
       * Records that this Session produced this drive file. Conflict target is
       * the (owner, session, ark file) key, so a repeated sync refreshes the
       * snapshot instead of duplicating the association. A tombstoned row stays
       * hidden: the update only applies while the existing deletion_state is
       * `none`, and a fresh insert is refused once the owning Session has begun
       * deleting, so a late sync can never resurrect deleted state.
       */
      upsertAssociation(input: ArtifactRecord, signal?: AbortSignal) {
        signal?.throwIfAborted();
        return db.transaction(async (transaction) => {
          await transaction.execute(sql`set local lock_timeout='5000'`);
          const session = await first(
            transaction,
            sql`select id from sessions where
            id=${input.sessionId} and owner_user_id=${input.ownerUserId} and deletion_state='none' for update`,
          );
          signal?.throwIfAborted();
          if (!session) throw new Error("Artifact session unavailable");
          const previous = await first<{ driveFileId: string }>(
            transaction,
            sql`select drive_file_id as "driveFileId" from artifacts
              where owner_user_id=${input.ownerUserId} and session_id=${input.sessionId}
              and ark_file_id=${input.arkFileId}`,
          );
          // Lock both versions before the association, matching reuse/delete.
          await transaction.execute(
            sql`select id from drive_files where owner_user_id=${input.ownerUserId}
              and (id=${input.driveFileId} or id=${previous?.driveFileId ?? input.driveFileId})
              order by id for update`,
          );
          const drive = await first(
            transaction,
            sql`select id from drive_files where id=${input.driveFileId}
              and owner_user_id=${input.ownerUserId} and deletion_state='none'`,
          );
          if (!drive) throw new Error("Artifact drive unavailable");
          await transaction.execute(
            sql`select id from background_jobs where id=${input.driveFileId}
              and type='cleanup_drive_object' for update`,
          );
          const reclaiming = await first(
            transaction,
            sql`select id from background_jobs where id=${input.driveFileId}
              and type='cleanup_drive_object' and status='running'`,
          );
          if (reclaiming) throw new Error("Artifact drive cleanup in progress");
          // A concurrent first sync may have staged its own drive row for the
          // same source: whichever upsert lands second wins the association,
          // and the replaced row must not leak — orphan it here (when nothing
          // else references it) so the GC can reclaim its bytes.
          await transaction.execute(
            sql`select drive_file_id as "driveFileId"
                  from artifacts
                 where owner_user_id = ${input.ownerUserId}
                   and session_id = ${input.sessionId}
                   and ark_file_id = ${input.arkFileId}
                 for update`,
          );
          const association = await requiredFirst<ArtifactRecord & Row>(
            transaction,
            sql`insert into artifacts
                  (id, owner_user_id, session_id, ark_file_id, drive_file_id,
                   name, mime_type, size_bytes, generated_at, deletion_state,
                   last_error_code, created_at, updated_at)
                select ${input.id}, ${input.ownerUserId}, ${input.sessionId},
                       ${input.arkFileId}, ${input.driveFileId}, ${input.name},
                       ${input.mimeType}, ${input.sizeBytes}, ${input.generatedAt},
                       'none', null, ${input.createdAt}, ${input.updatedAt}
                 where exists (
                   select 1
                     from sessions
                    where sessions.id = ${input.sessionId}
                      and sessions.owner_user_id = ${input.ownerUserId}
                      and sessions.deletion_state = 'none'
                 )
                on conflict (owner_user_id, session_id, ark_file_id) do update
                  set drive_file_id = excluded.drive_file_id,
                      name = excluded.name,
                      mime_type = excluded.mime_type,
                      size_bytes = excluded.size_bytes,
                      generated_at = excluded.generated_at,
                      last_error_code = null,
                      updated_at = excluded.updated_at
                where artifacts.deletion_state = 'none'
                returning ${artifactSelection}`,
          );
          await transaction.execute(
            sql`update drive_files set orphaned_at=null,updated_at=now()
              where id=${association.driveFileId} and owner_user_id=${input.ownerUserId}`,
          );
          // Activation and retiring the durable copy cleanup are atomic. A crash
          // before this transaction leaves the original delayed job reclaimable.
          await transaction.execute(sql`update background_jobs set status='succeeded',
            locked_at=null,locked_by=null,last_error=null,updated_at=now()
            where id=${association.driveFileId} and owner_user_id=${input.ownerUserId}
              and type='cleanup_drive_object' and status='pending'`);
          const replaced = previous?.driveFileId;
          if (
            replaced &&
            replaced !== association.driveFileId &&
            association.driveFileId === input.driveFileId
          ) {
            await transaction.execute(
              sql`update drive_files
                     set orphaned_at = now(), updated_at = now()
                   where id = ${replaced}
                     and owner_user_id = ${input.ownerUserId}
                     and deletion_state = 'none'
                     and orphaned_at is null
                     and not exists (
                       select 1 from artifacts artifact
                        where artifact.drive_file_id = ${replaced}
                          and artifact.owner_user_id = ${input.ownerUserId}
                          and artifact.deletion_state <> 'deleted'
                     )`,
            );
          }
          signal?.throwIfAborted();
          return association;
        });
      },
      listOwned(userId: string, sessionId?: string) {
        return rows<ArtifactRecord & Row>(
          db,
          sql`select ${artifactSelection}
                from artifacts
               where artifacts.owner_user_id = ${userId}
                 and (${sessionId ?? null}::uuid is null
                      or artifacts.session_id = ${sessionId ?? null})
                 and artifacts.deletion_state = 'none'
               order by artifacts.generated_at desc, artifacts.id desc`,
        );
      },
      findOwned(userId: string, id: string) {
        return first<ArtifactRecord & Row>(
          db,
          sql`select ${artifactSelection}
                from artifacts
               where artifacts.id = ${id}
                 and artifacts.owner_user_id = ${userId}
                 and artifacts.deletion_state <> 'deleted'
               limit 1`,
        );
      },
      /**
       * Deleting the association does not delete the bytes: the drive row is
       * left to the GC, which reaps it after the configured retention. This is
       * what lets a future drive mode keep Agent output while the Session goes.
       */
      requestDelete(id: string, userId: string, at: Date) {
        return db.transaction(async (transaction) => {
          const target = await first<{ driveFileId: string }>(
            transaction,
            sql`select drive_file_id as "driveFileId"
                  from artifacts
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and deletion_state <> 'deleted'
                 limit 1`,
          );
          if (!target) return undefined;
          await transaction.execute(
            sql`select id
                  from drive_files
                 where id = ${target.driveFileId}
                   and owner_user_id = ${userId}
                 for update`,
          );
          const previous = await first<{ deletionState: string }>(
            transaction,
            sql`select deletion_state::text as "deletionState"
                  from artifacts
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and deletion_state <> 'deleted'
                 limit 1`,
          );
          if (!previous) return undefined;
          const association = await first<ArtifactRecord & Row>(
            transaction,
            sql`update artifacts
                  set deletion_state = 'pending',
                      last_error_code = null,
                      updated_at = ${at}
                where artifacts.id = ${id}
                  and artifacts.owner_user_id = ${userId}
                  and artifacts.deletion_state <> 'deleted'
                returning ${artifactSelection}`,
          );
          if (!association) return undefined;
          if (previous.deletionState === "none") {
            await transaction.execute(
              sql`update drive_files
                    set orphaned_at = ${at},
                        updated_at = ${at}
                  where id = ${association.driveFileId}
                    and owner_user_id = ${userId}
                    and deletion_state <> 'deleted'
                    and not exists (
                      select 1
                        from artifacts live
                       where live.drive_file_id = drive_files.id
                         and live.owner_user_id = drive_files.owner_user_id
                         and live.deletion_state = 'none'
                    )`,
            );
          }
          return association;
        });
      },
      findDeleting(userId: string, id: string) {
        return first<ArtifactRecord & Row>(
          db,
          sql`select ${artifactSelection}
                from artifacts
               where artifacts.id = ${id}
                 and artifacts.owner_user_id = ${userId}
                 and artifacts.deletion_state in (
                   'pending',
                   'deletion_failed',
                   'deleted'
                 )
               limit 1`,
        );
      },
      async hasInputReferences(
        userId: string,
        driveId: string,
        objectKey: string,
      ) {
        const found = await first(
          db,
          sql`select ref.id from session_inputs ref
          where (ref.drive_file_id=${driveId} or ref.reused_object_key=${objectKey})
          and ref.owner_user_id=${userId}
          union all select a.id from artifacts a where a.drive_file_id=${driveId}
          and a.owner_user_id=${userId} and a.deletion_state='none' limit 1`,
        );
        return Boolean(found);
      },
      async markDeleted(id: string, userId: string) {
        const removed = await rows(
          db,
          sql`update artifacts
                 set name = '',
                     mime_type = 'application/octet-stream',
                     size_bytes = 0,
                     deletion_state = 'deleted',
                     last_error_code = null,
                     updated_at = now()
               where id = ${id}
                 and owner_user_id = ${userId}
                 and deletion_state in (
                   'pending',
                   'deletion_failed',
                   'deleted'
                 )
               returning id, drive_file_id as "driveFileId"`,
        );
        // Keep the drive row consistent with its bytes: an explicit artifact
        // delete removed the object, so the drive must not later enqueue a
        // second cleanup for it.
        if (removed.length === 1) {
          await db.execute(
            sql`update drive_files
                   set deletion_state = 'deleted',
                       name = '',
                       mime_type = 'application/octet-stream',
                       size_bytes = 0,
                       write_lease_until = null,
                       last_error_code = null,
                       updated_at = now()
                 where id = ${(removed[0] as { driveFileId: string }).driveFileId}
                   and owner_user_id = ${userId}
                   and deletion_state <> 'deleted'`,
          );
        }
        return removed.length === 1;
      },
    },

    driveFiles: {
      /**
       * Pre-delete guard for cleanup workers: the processor re-reads the live
       * row before destroying bytes, so a claim taken before a commit or a
       * lease extension cannot delete an object that has become live again.
       * `orphanedAt` separates the two `none` cases: an orphaned row is the
       * GC's own reclamation target, while a non-orphaned committed row is a
       * live object a racing cleanup intent must never reap.
       */
      findCleanupGuard(driveFileId: string) {
        return first<{
          ownerUserId: string;
          deletionState: "pending" | "none" | "deletion_failed" | "deleted";
          writeLeaseUntil: Date | null;
          orphanedAt: Date | null;
        }>(
          db,
          sql`select owner_user_id as "ownerUserId",
                     deletion_state::text as "deletionState",
                     write_lease_until as "writeLeaseUntil",
                     case when exists(select 1 from session_inputs ref where ref.drive_file_id=drive_files.id)
                       or exists(select 1 from artifacts a where a.drive_file_id=drive_files.id and a.deletion_state='none')
                       then null else orphaned_at end as "orphanedAt"
                from drive_files
               where id = ${driveFileId}
               limit 1`,
        );
      },
      switchObjectKey(
        id: string,
        ownerUserId: string,
        input: {
          objectKey: string;
          mimeType: string;
          sizeBytes: number;
          contentHash?: string;
          signal?: AbortSignal;
        },
      ) {
        input.signal?.throwIfAborted();
        return db.transaction(async (transaction) => {
          await transaction.execute(sql`set local lock_timeout='5000'`);
          const switched = await first<DriveFileRecord & Row>(
            transaction,
            sql`update drive_files
                 set tos_object_key = ${input.objectKey},
                     mime_type = ${input.mimeType},
                     size_bytes = ${input.sizeBytes},
                     content_hash = ${
                       input.contentHash === undefined
                         ? null
                         : input.contentHash
                     },
                     updated_at = now()
               where id = ${id}
                 and owner_user_id = ${ownerUserId}
                 and deletion_state = 'none'
                 and orphaned_at is null
               returning ${driveFileSelection}`,
          );
          input.signal?.throwIfAborted();
          return switched;
        });
      },
      /**
       * Enqueues the legacy key-addressed cleanup for a key retired by an
       * object switch. The payload marks the job as switch-retired so the
       * processor can delete ownerless bytes without violating the
       * fail-closed rule for genuine legacy jobs.
       */
      async enqueueRetiredKeyCleanup(
        objectKey: string,
        ownerUserId: string,
      ): Promise<void> {
        await db.execute(
          sql`insert into background_jobs
                (id, owner_user_id, type, status, priority, payload,
                 attempts, run_after)
              values
                (${randomUUID()}, ${ownerUserId}, 'cleanup_artifact_object',
                 'pending', 90,
                 ${JSON.stringify({
                   objectKey,
                   cleanupGeneration: 0,
                   retiredBySwitch: true,
                 })}::jsonb,
                 0, now())`,
        );
      },
      findObjectCleanupGuard(objectKey: string) {
        return first<{
          ownerUserId: string;
          deletionState: "pending" | "none" | "deletion_failed" | "deleted";
          writeLeaseUntil: Date | null;
          orphanedAt: Date | null;
        }>(
          db,
          sql`select owner_user_id as "ownerUserId",
                     deletion_state::text as "deletionState",
                     write_lease_until as "writeLeaseUntil",
                     orphaned_at as "orphanedAt"
                from drive_files
               where tos_object_key = ${objectKey}
               union all select owner_user_id,'none'::text,null::timestamptz,null::timestamptz from session_inputs
                where reused_object_key=${objectKey}
               limit 1`,
        );
      },
      /**
       * Re-reads the CURRENT claim state of a cleanup job just before its
       * destructive step. A generation or lock-owner mismatch means this
       * execution lost the job (re-armed or taken over) and must not touch
       * bytes, even though its own claim snapshot still looks valid.
       */
      findCleanupJobClaim(jobId: string, ownerUserId: string) {
        return first<{
          generation: number;
          lockedBy: string | null;
          lockedAt: Date | null;
          type: string;
          leaseGeneration: number;
        }>(
          db,
          sql`select coalesce((payload ->> 'cleanupGeneration')::integer, 0)
                    as "generation",
                  locked_by as "lockedBy",
                  locked_at as "lockedAt",
                  type::text as "type",
                  lease_generation as "leaseGeneration"
                from background_jobs
               where id = ${jobId}
                 and owner_user_id = ${ownerUserId}
               limit 1`,
        );
      },
      /**
       * Reserves a drive row in `pending` with a write lease and a delayed
       * cleanup intent. A crash before commit leaves the intent behind, so the
       * half-written object is still reclaimed.
       */
      async stage(input: {
        id: string;
        ownerUserId: string;
        origin: "upload" | "artifact" | "import";
        objectKey: string;
        name: string;
        mimeType: string;
        sizeBytes: number;
        contentHash?: string;
        sourceSessionId?: string;
        runAfter: Date;
        writeLeaseUntil: Date;
      }) {
        return db.transaction(async (transaction) => {
          // Fence: a sync that passed authorization earlier must not stage
          // bytes once the owning Session is already being deleted, or the
          // object would leak past the deletion saga's orphaning pass.
          if (input.sourceSessionId) {
            const session = await first(
              transaction,
              sql`select id
                    from sessions
                   where id = ${input.sourceSessionId}
                     and owner_user_id = ${input.ownerUserId}
                     and deletion_state = 'none'
                   for update`,
            );
            if (!session) return false;
          }
          await transaction.execute(
            sql`insert into drive_files
                  (id, owner_user_id, origin, tos_object_key, name, mime_type,
                   size_bytes, content_hash, source_session_id, deletion_state,
                   write_lease_until, created_at, updated_at)
                values
                  (${input.id}, ${input.ownerUserId}, ${input.origin},
                   ${input.objectKey}, ${input.name}, ${input.mimeType},
                   ${input.sizeBytes}, ${input.contentHash ?? null},
                   ${input.sourceSessionId ?? null}, 'pending',
                   ${input.writeLeaseUntil}, now(), now())`,
          );
          await transaction.execute(
            sql`insert into background_jobs
                  (id, owner_user_id, type, status, priority, payload,
                   attempts, run_after)
                values
                  (${input.id}, ${input.ownerUserId}, 'cleanup_drive_object',
                   'pending', 90,
                   ${JSON.stringify({
                     driveFileId: input.id,
                     cleanupGeneration: 0,
                     uploadInProgressUntil: input.writeLeaseUntil.toISOString(),
                   })}::jsonb,
                   0, ${input.runAfter})`,
          );
          return true;
        });
      },
      /**
       * Promotes a staged row to `none`; artifact copies keep their delayed cleanup
       * intent and orphan flag until association activation. Other origins retire
       * the intent, unless
       * a later stage re-armed it (generation changed) or the row was already
       * deleted — in which case the caller must not treat the write as live.
       */
      commit(input: { id: string; ownerUserId: string; signal?: AbortSignal }) {
        input.signal?.throwIfAborted();
        return db.transaction(async (transaction) => {
          await transaction.execute(sql`set local lock_timeout='5000'`);
          const source = await first<{ sourceSessionId: string | null }>(
            transaction,
            sql`select source_session_id as "sourceSessionId" from drive_files
              where id=${input.id} and owner_user_id=${input.ownerUserId}`,
          );
          let sessionAvailable = true;
          if (source?.sourceSessionId) {
            sessionAvailable = Boolean(
              await first(
                transaction,
                sql`select id from sessions where
              id=${source.sourceSessionId} and owner_user_id=${input.ownerUserId}
              and deletion_state='none' for update`,
              ),
            );
          }
          input.signal?.throwIfAborted();
          const record = await first<DriveFileRecord & Row>(
            transaction,
            sql`select ${driveFileSelection}
                  from drive_files
                 where id = ${input.id}
                   and owner_user_id = ${input.ownerUserId}
                 for update`,
          );
          if (!record) {
            throw new Error("Drive file staging was not found");
          }
          if (record.deletionState !== "pending") {
            return { record, activated: false };
          }
          // Fence the commit too: if the owning Session started deleting after
          // this object was staged, its orphaning pass already ran and would
          // miss this row. Leave it pending so the staged cleanup intent reaps
          // the bytes instead of leaking them.
          if (!sessionAvailable) return { record, activated: false };
          input.signal?.throwIfAborted();
          const activated = await first<DriveFileRecord & Row>(
            transaction,
            sql`update drive_files
                   set deletion_state = 'none',
                       orphaned_at = case when origin='artifact' then now() else orphaned_at end,
                       write_lease_until = null,
                       last_error_code = null,
                       updated_at = now()
                 where id = ${input.id}
                   and owner_user_id = ${input.ownerUserId}
                   and deletion_state = 'pending'
                 returning ${driveFileSelection}`,
          );
          if (!activated) {
            return { record, activated: false };
          }
          await transaction.execute(
            sql`update background_jobs
                   set status = case when ${activated.origin}='artifact' then 'pending'::background_job_status else 'succeeded'::background_job_status end,
                       payload = payload - 'uploadInProgressUntil',
                       locked_at = null,
                       locked_by = null,
                       last_error = null,
                       updated_at = now()
                 where id = ${input.id}
                   and owner_user_id = ${input.ownerUserId}
                   and type = 'cleanup_drive_object'
                   and status = 'pending'`,
          );
          input.signal?.throwIfAborted();
          return { record: activated, activated: true };
        });
      },
      async release(id: string, userId: string) {
        await db.execute(
          sql`update background_jobs
                set payload =
                      (payload - 'uploadInProgressUntil')
                      || jsonb_build_object(
                        'cleanupGeneration',
                        coalesce((payload ->> 'cleanupGeneration')::integer, 0)
                          + 1
                      ),
                    status = case
                      when status = 'running' then status
                      else 'pending'
                    end,
                    attempts = 0,
                    run_after = case
                      when status = 'running' then run_after
                      else now()
                    end,
                    locked_at = case
                      when status = 'running' then locked_at
                      else null
                    end,
                    locked_by = case
                      when status = 'running' then locked_by
                      else null
                    end,
                    last_error = null,
                    updated_at = now()
              where id = ${id}
                and owner_user_id = ${userId}
                and type = 'cleanup_drive_object'`,
        );
      },
      findOwned(userId: string, id: string) {
        return first<DriveFileRecord & Row>(
          db,
          sql`select ${driveFileSelection}
                from drive_files
               where id = ${id}
                 and owner_user_id = ${userId}
               limit 1`,
        );
      },
      async orphan(id: string, userId: string, at: Date) {
        const updated = await rows(
          db,
          sql`update drive_files
                 set orphaned_at = coalesce(orphaned_at, ${at}),
                     updated_at = now()
               where id = ${id}
                 and owner_user_id = ${userId}
                 and deletion_state = 'none'
               returning id`,
        );
        return updated.length === 1;
      },
      /**
       * Selects committed, orphaned rows past the retention window and enqueues
       * `cleanup_drive_object` for each. The orphaned flag stays set so the job
       * is the single reaper; a row already carrying a live job is skipped.
       */
      claimOrphans(input: { limit: number; retentionMs: number; now: Date }) {
        return db.transaction(async (transaction) => {
          const cutoff = new Date(input.now.getTime() - input.retentionMs);
          const candidates = await rows<{ id: string; ownerUserId: string }>(
            transaction,
            sql`select drive.id, drive.owner_user_id as "ownerUserId"
                  from drive_files drive
                 where drive.deletion_state = 'none'
                   and (
                     drive.orphaned_at <= ${cutoff}
                     or (drive.orphaned_at is null and drive.origin='artifact'
                       and drive.created_at <= ${cutoff}
                       and exists (
                         select 1 from background_jobs retired
                         where retired.id=drive.id
                           and retired.owner_user_id=drive.owner_user_id
                           and retired.type='cleanup_drive_object'
                           and retired.status='succeeded'
                       ))
                   )
                   and drive.folder_id is null
                   and (drive.write_lease_until is null
                        or drive.write_lease_until <= ${input.now})
                   and not exists (
                     select 1
                       from artifacts live
                      where live.drive_file_id = drive.id
                        and live.owner_user_id = drive.owner_user_id
                        and live.deletion_state = 'none'
                   )
                   and not exists(select 1 from session_inputs ref where ref.drive_file_id=drive.id
                     and ref.owner_user_id=drive.owner_user_id)
                   and not exists (
                     select 1
                       from background_jobs job
                      where job.id = drive.id
                        and job.status in ('pending', 'running')
                   )
                 order by coalesce(drive.orphaned_at,drive.created_at) asc, drive.id asc
                 for update skip locked
                 limit ${input.limit}`,
          );
          for (const candidate of candidates) {
            // Recover pre-fix committed artifact copies whose cleanup retired
            // before association. Their age already passed normal retention;
            // the locked row has no live references, job, folder or write lease.
            await transaction.execute(sql`update drive_files
              set orphaned_at=coalesce(orphaned_at,created_at),updated_at=${input.now}
              where id=${candidate.id} and owner_user_id=${candidate.ownerUserId}`);
            // The drive id doubles as the cleanup job id, so the row usually
            // already exists — the retired staging intent. Re-arm it rather
            // than inserting, or the orphan would never be reaped.
            await transaction.execute(
              sql`insert into background_jobs
                    (id, owner_user_id, type, status, priority, payload,
                     attempts, run_after)
                  values
                    (${candidate.id}, ${candidate.ownerUserId},
                     'cleanup_drive_object', 'pending', 90,
                     ${JSON.stringify({
                       driveFileId: candidate.id,
                       cleanupGeneration: 0,
                     })}::jsonb,
                     0, ${input.now})
                  on conflict (id) do update
                    set type = 'cleanup_drive_object',
                        status = 'pending',
                        priority = 90,
                        payload = excluded.payload,
                        attempts = 0,
                        run_after = excluded.run_after,
                        locked_at = null,
                        locked_by = null,
                        last_error = null,
                        updated_at = ${input.now}
                  where background_jobs.status in ('succeeded', 'failed')`,
            );
          }
          return candidates.length;
        });
      },
      async markDeleted(id: string, userId: string) {
        return db.transaction(async (transaction) => {
          const removed = await rows(
            transaction,
            sql`update drive_files
                   set deletion_state = 'deleted',
                       name = '',
                       mime_type = 'application/octet-stream',
                       size_bytes = 0,
                       write_lease_until = null,
                       last_error_code = null,
                       updated_at = now()
                 where id = ${id}
                   and owner_user_id = ${userId}
                   and deletion_state <> 'deleted'
                   and folder_id is null
                   and not exists (
                     select 1
                       from artifacts live
                      where live.drive_file_id = drive_files.id
                        and live.owner_user_id = drive_files.owner_user_id
                        and live.deletion_state = 'none'
                   )
                   and not exists(select 1 from session_inputs ref where ref.drive_file_id=drive_files.id
                     and ref.owner_user_id=${userId})
                 returning id`,
          );
          if (removed.length !== 1) return false;
          // The bytes are gone, so any association that pointed at them must
          // stop being visible. Associations are dropped with their Session
          // normally, but an explicit artifact delete leaves the row behind.
          await transaction.execute(
            sql`update artifacts
                   set name = '',
                       mime_type = 'application/octet-stream',
                       size_bytes = 0,
                       deletion_state = 'deleted',
                       last_error_code = null,
                       updated_at = now()
                 where drive_file_id = ${id}
                   and owner_user_id = ${userId}
                   and deletion_state <> 'deleted'`,
          );
          return true;
        });
      },
    },

    defaultAgents: {
      findForUser(userId: string) {
        return first<DefaultAgentRecord>(
          db,
          sql`select user_id as "userId",
                     platform_agent_id as "platformAgentId",
                     assigned_by as "assignedBy",
                     assigned_at as "assignedAt"
                from user_default_agents
               where user_id = ${userId}
               limit 1`,
        );
      },
      assign(input: {
        userId: string;
        platformAgentId: string;
        assignedBy: string;
      }) {
        return db.transaction(async (transaction) => {
          const eligible = await first(
            transaction,
            sql`select pa.id
                  from platform_agents pa
                  join users target on target.id = ${input.userId}
                  join users administrator on administrator.id = ${input.assignedBy}
                 where pa.id = ${input.platformAgentId}
                   and pa.status = 'active'
                   and target.role = 'user'
                   and target.status = 'active'
                   and administrator.role = 'admin'
                   and administrator.status = 'active'
                 for update of pa, target`,
          );
          if (!eligible) {
            throw new Error(
              "Default assignment requires an active platform agent, active user, and active admin",
            );
          }

          return first<DefaultAgentRecord>(
            transaction,
            sql`insert into user_default_agents
                  (user_id, platform_agent_id, assigned_by)
                values
                  (${input.userId}, ${input.platformAgentId}, ${input.assignedBy})
                on conflict (user_id) do update
                  set platform_agent_id = excluded.platform_agent_id,
                      assigned_by = excluded.assigned_by,
                      assigned_at = now()
                returning user_id as "userId",
                          platform_agent_id as "platformAgentId",
                          assigned_by as "assignedBy",
                          assigned_at as "assignedAt"`,
          );
        });
      },
    },

    quotas: {
      getEffective(userId: string) {
        return effectiveQuota(db, userId);
      },
      async reserveSession(input: {
        userId: string;
        reservationId: string;
        expiresAt: Date;
        now?: Date;
      }) {
        const result = await db.transaction(async (transaction) => {
          const now = input.now ?? new Date();
          const user = await first(
            transaction,
            sql`select id from users
                 where id = ${input.userId} and status = 'active'
                 for update`,
          );
          if (!user) {
            throw new Error("Active user not found");
          }

          const quota = await effectiveQuota(transaction, input.userId);
          const month = utcMonthWindow(now);
          const day = utcDayWindow(now);
          await preserveExpiredCreateOutcomes(transaction, input.userId, now);
          const counters = await first<{
            activeReservations: number;
            concurrentSessions: number;
            dailySessions: number;
            monthlyTokens: number;
          }>(
            transaction,
            sql`select
                  (select count(*)::integer
                     from quota_reservations
                    where user_id = ${input.userId}
                      and status = 'active'
                      and expires_at > ${now}) as "activeReservations",
                  (select count(*)::integer
                     from sessions
                    where owner_user_id = ${input.userId}
                      and status in ('running', 'rescheduled')
                      and deletion_state <> 'deleted') as "concurrentSessions",
                  (select count(*)::integer
                     from quota_reservations
                    where user_id = ${input.userId}
                      and status in ('active', 'unknown_outcome', 'consumed')
                      and created_at >= ${day.start}
                      and created_at < ${day.end})
                    as "dailySessions",
                  (select coalesce(sum(quantity), 0)::bigint
                     from usage_ledger
                    where user_id = ${input.userId}
                      and metric_type in ('input_tokens', 'output_tokens')
                      and recorded_at >= ${month.start}
                      and recorded_at < ${month.end})
                    as "monthlyTokens"`,
          );
          if (!counters) {
            throw new Error("Unable to read quota counters");
          }

          if (quota.mode === "enforced") {
            if (
              counters.concurrentSessions + counters.activeReservations >=
              quota.concurrentSessionLimit
            ) {
              return { quotaExceeded: "concurrent_sessions" as const };
            }
            if (counters.dailySessions >= quota.dailySessionLimit) {
              return { quotaExceeded: "daily_sessions" as const };
            }
            if (counters.monthlyTokens >= quota.monthlyTokenLimit) {
              return { quotaExceeded: "monthly_tokens" as const };
            }
          }

          await transaction.execute(
            sql`insert into quota_reservations
                  (id, user_id, ark_session_id, expires_at, created_at)
                values
                  (${input.reservationId}, ${input.userId},
                   ${`pending:${input.reservationId}`}, ${input.expiresAt},
                   ${now})`,
          );
          return { id: input.reservationId, quota };
        });
        if ("quotaExceeded" in result) {
          throw new QuotaExceededError(result.quotaExceeded);
        }
        return result;
      },
      async consumeReservation(input: {
        reservationId: string;
        arkSessionId: string;
      }) {
        return db.transaction((transaction) =>
          consumeReservationIdentity(transaction, input),
        );
      },
      releaseReservation(reservationId: string) {
        return first(
          db,
          sql`update quota_reservations
                set status = 'released', resolved_at = now()
              where id = ${reservationId}
                and status in ('active', 'unknown_outcome')
              returning id, user_id as "userId", status,
                        resolved_at as "resolvedAt"`,
        );
      },
    },

    usage: {
      findOwned(userId: string, id: string) {
        return first<OwnedRecord>(
          db,
          sql`select id, user_id as "ownerUserId"
                from usage_ledger
               where id = ${id} and user_id = ${userId}
               limit 1`,
        );
      },
      listReconcilable(input: { cutoff: Date; limit: number }) {
        return rows<{
          sessionId: string;
          ownerUserId: string;
          arkSessionId: string;
          status: SessionRecord["status"];
        }>(
          db,
          sql`select session.id as "sessionId",
                     session.owner_user_id as "ownerUserId",
                     session.ark_session_id as "arkSessionId", session.status
                from sessions session
                left join session_event_cursors cursor
                  on cursor.session_id = session.id
               where session.ark_session_id not like 'pending:%'
                 and session.deletion_state not in ('pending', 'deleted')
                 and (
                   session.status in ('running', 'rescheduled')
                   or session.updated_at >= ${input.cutoff}
                 )
               order by cursor.last_reconciled_at asc nulls first,
                        session.updated_at, session.id
               limit ${input.limit}`,
        );
      },
      async markReconciled(
        userId: string,
        sessionId: string,
        reconciledAt: Date,
      ) {
        await db.execute(
          sql`insert into session_event_cursors
                (session_id, last_reconciled_at)
              select id, ${reconciledAt}
                from sessions
               where id = ${sessionId}
                 and owner_user_id = ${userId}
              on conflict (session_id) do update
                set last_reconciled_at = greatest(
                      coalesce(
                        session_event_cursors.last_reconciled_at,
                        excluded.last_reconciled_at
                      ),
                      excluded.last_reconciled_at
                    ),
                    updated_at = now()`,
        );
      },
      monthlyTokens(userId: string, now: Date) {
        const window = utcMonthWindow(now);
        return first<{ total: number }>(
          db,
          sql`select coalesce(sum(quantity), 0)::bigint as total
                from usage_ledger
               where user_id = ${userId}
                 and metric_type in ('input_tokens', 'output_tokens')
                 and recorded_at >= ${window.start}
                 and recorded_at < ${window.end}`,
        ).then((row) => Number(row?.total ?? 0));
      },
      async monthlyTokenState(userId: string, now: Date) {
        const window = utcMonthWindow(now);
        const [quota, usage] = await Promise.all([
          effectiveQuota(db, userId),
          first<{ total: number }>(
            db,
            sql`select coalesce(sum(quantity), 0)::bigint as total
                  from usage_ledger
                 where user_id = ${userId}
                   and metric_type in ('input_tokens', 'output_tokens')
                   and recorded_at >= ${window.start}
                   and recorded_at < ${window.end}`,
          ),
        ]);
        return {
          used: Number(usage?.total ?? 0),
          limit: quota.monthlyTokenLimit,
        };
      },
      async adminOverview(input: {
        now: Date;
        limit: number;
        before: { tokens: number; userId: string } | null;
      }) {
        const window = utcMonthWindow(input.now);
        const day = utcDayWindow(input.now);
        const snap = sql`
          with monthly as (
            select user_id,
                   coalesce(sum(quantity) filter (
                     where metric_type = 'input_tokens'), 0)::bigint as input_tokens,
                   coalesce(sum(quantity) filter (
                     where metric_type = 'output_tokens'), 0)::bigint as output_tokens,
                   coalesce(sum(quantity) filter (
                     where metric_type = 'tool_calls'), 0)::bigint as tool_calls
              from usage_ledger
             where recorded_at >= ${window.start} and recorded_at < ${window.end}
             group by user_id
          ),
          snap as (
            select u.id, u.email, u.role, u.status,
                   coalesce(o.personal_agent_limit, p.personal_agent_limit)::integer
                     as "personalAgentLimit",
                   coalesce(o.concurrent_session_limit, p.concurrent_session_limit)::integer
                     as "concurrentSessionLimit",
                   coalesce(o.daily_session_limit, p.daily_session_limit)::integer
                     as "dailySessionLimit",
                   coalesce(o.monthly_token_limit, p.monthly_token_limit)::bigint
                     as "monthlyTokenLimit",
                   (select count(*)::integer from personal_agents pa
                     where pa.owner_user_id = u.id
                       and not (pa.status = 'failed' and pa.ark_version = '0'
                                and pa.ark_agent_id like 'pending:%'))
                     as "personalAgents",
                   (select count(*)::integer from sessions s
                     where s.owner_user_id = u.id
                       and s.status in ('running', 'rescheduled')
                       and s.deletion_state <> 'deleted')
                     as "concurrentSessions",
                   (select count(*)::integer from quota_reservations reservation
                     where reservation.user_id = u.id
                       and reservation.status in (
                         'active', 'unknown_outcome', 'consumed'
                       )
                       and reservation.created_at >= ${day.start}
                       and reservation.created_at < ${day.end})
                     as "dailySessions",
                   coalesce(m.input_tokens, 0)::bigint as "inputTokens",
                   coalesce(m.output_tokens, 0)::bigint as "outputTokens",
                   coalesce(m.tool_calls, 0)::bigint as "toolCalls"
              from users u
              join quota_policies p on p.key = 'default'
              left join user_quota_overrides o on o.user_id = u.id
              left join monthly m on m.user_id = u.id
          )`;
        const totals = await first<{
          inputTokens: number;
          outputTokens: number;
          sessions: number;
          activeUsers: number;
          exhaustedUsers: number;
        }>(
          db,
          sql`${snap}
              select
                (select coalesce(sum("inputTokens"), 0)::bigint from snap) as "inputTokens",
                (select coalesce(sum("outputTokens"), 0)::bigint from snap) as "outputTokens",
                (select count(*)::integer from quota_reservations reservation
                  where reservation.status in (
                    'active', 'unknown_outcome', 'consumed'
                  )
                    and reservation.created_at >= ${window.start}
                    and reservation.created_at < ${window.end}) as "sessions",
                (select count(*)::integer from snap
                  where "inputTokens" > 0 or "outputTokens" > 0) as "activeUsers",
                (select count(*)::integer from snap
                  where "personalAgents" >= "personalAgentLimit"
                     or "concurrentSessions" >= "concurrentSessionLimit"
                     or "dailySessions" >= "dailySessionLimit"
                     or ("inputTokens" + "outputTokens") >= "monthlyTokenLimit")
                  as "exhaustedUsers"`,
        );
        const rowsFilter = input.before
          ? sql`where ("inputTokens" + "outputTokens", id)
                    < (${input.before.tokens}::bigint, ${input.before.userId}::uuid)`
          : sql``;
        const userRows = await rows<{
          userId: string;
          email: string;
          role: "user" | "admin";
          status: "active" | "disabled";
          personalAgentLimit: number;
          concurrentSessionLimit: number;
          dailySessionLimit: number;
          monthlyTokenLimit: number;
          personalAgents: number;
          concurrentSessions: number;
          dailySessions: number;
          inputTokens: number;
          outputTokens: number;
          toolCalls: number;
          tokens: number;
        }>(
          db,
          sql`${snap}
              select id as "userId", email, role, status,
                     "personalAgentLimit", "concurrentSessionLimit",
                     "dailySessionLimit", "monthlyTokenLimit",
                     "personalAgents", "concurrentSessions", "dailySessions",
                     "inputTokens", "outputTokens", "toolCalls",
                     ("inputTokens" + "outputTokens")::bigint as tokens
                from snap
                ${rowsFilter}
               order by tokens desc, id desc
               limit ${input.limit + 1}`,
        );
        const hasMore = userRows.length > input.limit;
        const users = (hasMore ? userRows.slice(0, input.limit) : userRows).map(
          (row) => ({
            userId: row.userId,
            email: row.email,
            role: row.role,
            status: row.status,
            quota: {
              personalAgentLimit: Number(row.personalAgentLimit),
              concurrentSessionLimit: Number(row.concurrentSessionLimit),
              dailySessionLimit: Number(row.dailySessionLimit),
              monthlyTokenLimit: Number(row.monthlyTokenLimit),
            },
            usage: {
              personalAgents: row.personalAgents,
              concurrentSessions: row.concurrentSessions,
              dailySessions: row.dailySessions,
              inputTokens: Number(row.inputTokens),
              outputTokens: Number(row.outputTokens),
              tokens: Number(row.tokens),
              toolCalls: Number(row.toolCalls),
            },
          }),
        );
        const last = users[users.length - 1];
        return {
          period: { startsAt: window.start, endsAt: window.end },
          totals: {
            inputTokens: Number(totals?.inputTokens ?? 0),
            outputTokens: Number(totals?.outputTokens ?? 0),
            tokens:
              Number(totals?.inputTokens ?? 0) +
              Number(totals?.outputTokens ?? 0),
            activeUsers: totals?.activeUsers ?? 0,
            sessions: totals?.sessions ?? 0,
            exhaustedUsers: totals?.exhaustedUsers ?? 0,
          },
          users,
          nextCursor:
            hasMore && last
              ? { tokens: last.usage.tokens, userId: last.userId }
              : null,
        };
      },
      async byAgents(input: { now: Date }) {
        const window = utcMonthWindow(input.now);
        const platform = await rows<{
          platformAgentId: string;
          name: string;
          status: string;
          defaultAssignments: number;
          inputTokens: number;
          outputTokens: number;
        }>(
          db,
          sql`select pa.id as "platformAgentId", pa.name, pa.status::text as status,
                     (select count(*)::integer from user_default_agents uda
                       where uda.platform_agent_id = pa.id) as "defaultAssignments",
                     coalesce(sum(ul.quantity) filter (
                       where ul.metric_type = 'input_tokens'), 0)::bigint as "inputTokens",
                     coalesce(sum(ul.quantity) filter (
                       where ul.metric_type = 'output_tokens'), 0)::bigint as "outputTokens"
                from platform_agents pa
                left join usage_ledger ul
                  on ul.platform_agent_id = pa.id
                 and ul.recorded_at >= ${window.start}
                 and ul.recorded_at < ${window.end}
               group by pa.id, pa.name, pa.status
               order by pa.name`,
        );
        const personal = await first<{
          personalAgents: number;
          inputTokens: number;
          outputTokens: number;
        }>(
          db,
          sql`select (select count(*)::integer from personal_agents pa
                       where not (pa.status = 'failed' and pa.ark_version = '0'
                                  and pa.ark_agent_id like 'pending:%'))
                     as "personalAgents",
                     coalesce(sum(ul.quantity) filter (
                       where ul.metric_type = 'input_tokens'), 0)::bigint as "inputTokens",
                     coalesce(sum(ul.quantity) filter (
                       where ul.metric_type = 'output_tokens'), 0)::bigint as "outputTokens"
                from usage_ledger ul
               where ul.agent_kind = 'personal'
                 and ul.recorded_at >= ${window.start}
                 and ul.recorded_at < ${window.end}`,
        );
        return {
          platform: platform.map((agent) => ({
            platformAgentId: agent.platformAgentId,
            name: agent.name,
            status: agent.status,
            defaultAssignments: agent.defaultAssignments,
            inputTokens: Number(agent.inputTokens),
            outputTokens: Number(agent.outputTokens),
          })),
          personal: {
            personalAgents: personal?.personalAgents ?? 0,
            tokens:
              Number(personal?.inputTokens ?? 0) +
              Number(personal?.outputTokens ?? 0),
          },
        };
      },
      async summary(userId: string, now: Date) {
        const month = utcMonthWindow(now);
        const day = utcDayWindow(now);
        const [quota, counters] = await Promise.all([
          effectiveQuota(db, userId),
          first<{
            personalAgents: number;
            concurrentSessions: number;
            dailySessions: number;
            inputTokens: number;
            outputTokens: number;
            runtimeMs: number;
            toolCalls: number;
          }>(
            db,
            sql`select
                  (select count(*)::integer
                     from personal_agents
                    where owner_user_id = ${userId}
                      and not (
                        status = 'failed'
                        and ark_version = '0'
                        and ark_agent_id like 'pending:%'
                      )) as "personalAgents",
                  (select count(*)::integer
                     from sessions
                    where owner_user_id = ${userId}
                      and status in ('running', 'rescheduled')
                      and deletion_state <> 'deleted')
                    as "concurrentSessions",
                  (select count(*)::integer
                     from quota_reservations
                    where user_id = ${userId}
                      and status in ('active', 'unknown_outcome', 'consumed')
                      and created_at >= ${day.start}
                      and created_at < ${day.end})
                    as "dailySessions",
                  coalesce(sum(quantity) filter (
                    where metric_type = 'input_tokens'
                  ), 0)::bigint as "inputTokens",
                  coalesce(sum(quantity) filter (
                    where metric_type = 'output_tokens'
                  ), 0)::bigint as "outputTokens",
                  coalesce(sum(quantity) filter (
                    where metric_type = 'runtime_ms'
                  ), 0)::bigint as "runtimeMs",
                  coalesce(sum(quantity) filter (
                    where metric_type = 'tool_calls'
                  ), 0)::bigint as "toolCalls"
                from usage_ledger
               where user_id = ${userId}
                 and recorded_at >= ${month.start}
                 and recorded_at < ${month.end}`,
          ),
        ]);
        if (!counters) throw new Error("Unable to read quota usage");
        const usage = {
          personalAgents: Number(counters.personalAgents),
          concurrentSessions: Number(counters.concurrentSessions),
          dailySessions: Number(counters.dailySessions),
          inputTokens: Number(counters.inputTokens),
          outputTokens: Number(counters.outputTokens),
          tokens: Number(counters.inputTokens) + Number(counters.outputTokens),
          runtimeMs: Number(counters.runtimeMs),
          toolCalls: Number(counters.toolCalls),
        };
        return {
          period: { startsAt: month.start, endsAt: month.end },
          quota,
          usage,
          exhausted: {
            personalAgents: usage.personalAgents >= quota.personalAgentLimit,
            concurrentSessions:
              usage.concurrentSessions >= quota.concurrentSessionLimit,
            dailySessions: usage.dailySessions >= quota.dailySessionLimit,
            monthlyTokens: usage.tokens >= quota.monthlyTokenLimit,
          },
        };
      },
      async recordByReservation(input: {
        id: string;
        reservationId: string;
        arkEventId: string;
        metricType: UsageMetricType;
        quantity: number;
        recordedAt?: Date;
      }) {
        // Post-deletion re-accounting has no verifiable Session snapshot to
        // attribute against, so it writes unknown precision and accepts no
        // model from the caller. Exact attribution for settlement evidence,
        // if ever added, belongs to the settlement task's own controlled
        // entry point.
        const inserted = await rows(
          db,
          sql`insert into usage_ledger
                (id, user_id, ark_session_id, ark_event_id, metric_type,
                 quantity, recorded_at, model_attribution_precision)
              select ${input.id}, reservation.user_id,
                     reservation.ark_session_id, ${input.arkEventId},
                     ${input.metricType}, ${input.quantity},
                     ${input.recordedAt ?? new Date()},
                     'unknown'::model_attribution_precision
                from quota_reservations reservation
               where reservation.id = ${input.reservationId}
                 and reservation.status <> 'released'
              on conflict
                (user_id, ark_session_id, ark_event_id, metric_type)
              do nothing
              returning id`,
        );
        return inserted.length === 1;
      },
    },

    quotaInterrupts: {
      claim(input: { workerId: string; limit: number; now?: Date }) {
        const now = input.now ?? new Date();
        const leaseExpiredAt = new Date(now.getTime() - JOB_LEASE_DURATION_MS);
        return db.transaction(async (transaction) => {
          await transaction.execute(
            sql`update quota_interrupt_jobs
                  set status = 'failed',
                      locked_at = null,
                      locked_by = null,
                      last_error = 'QUOTA_INTERRUPT_LEASE_EXPIRED',
                      updated_at = ${now}
                where status = 'running'
                  and locked_at <= ${leaseExpiredAt}
                  and attempts >= max_attempts`,
          );
          const claimed = await rows<QuotaInterruptJobRecord>(
            transaction,
            sql`with claimable as (
                  select id
                    from quota_interrupt_jobs
                   where (
                         (status = 'pending' and run_after <= ${now})
                         or
                         (status = 'running' and locked_at <= ${leaseExpiredAt})
                       )
                     and attempts < max_attempts
                   order by run_after, created_at, id
                   for update skip locked
                   limit ${input.limit}
                )
                update quota_interrupt_jobs job
                   set status = 'running',
                       attempts = job.attempts + 1,
                       lease_generation = job.lease_generation + 1,
                       locked_at = ${now},
                       locked_by = ${input.workerId},
                       updated_at = ${now}
                  from claimable
                 where job.id = claimable.id
                returning job.id, job.user_id as "userId",
                          job.session_id as "sessionId",
                          (select ark_session_id from sessions
                            where sessions.id = job.session_id
                              and sessions.owner_user_id = job.user_id)
                            as "arkSessionId",
                          job.month_start as "monthStart",
                          job.attempts,
                          job.max_attempts as "maxAttempts",
                          job.lease_generation as "leaseGeneration"`,
          );
          return claimed.map((job) => ({
            ...job,
            monthStart: new Date(job.monthStart),
          }));
        });
      },
      async succeed(id: string, workerId: string, leaseGeneration: number) {
        await db.execute(
          sql`update quota_interrupt_jobs
                set status = 'succeeded',
                    locked_at = null,
                    locked_by = null,
                    last_error = null,
                    updated_at = now()
              where id = ${id}
                and status = 'running'
                and locked_by = ${workerId}
                and lease_generation = ${leaseGeneration}`,
        );
      },
      async retry(
        id: string,
        workerId: string,
        error: string,
        final: boolean,
        leaseGeneration: number,
        now = new Date(),
      ) {
        await db.execute(
          sql`update quota_interrupt_jobs
                set status = ${final ? "failed" : "pending"}::background_job_status,
                    run_after = case
                      when ${final} then run_after
                      else ${new Date(now.getTime() + 30_000)}
                    end,
                    locked_at = null,
                    locked_by = null,
                    last_error = ${error},
                    updated_at = ${now}
              where id = ${id}
                and status = 'running'
                and locked_by = ${workerId}
                and lease_generation = ${leaseGeneration}`,
        );
      },
    },

    jobs: {
      async claim(input: {
        workerId: string;
        limit: number;
        now?: Date;
        types?: JobRecord["type"][];
      }) {
        const now = input.now ?? new Date();
        const leaseExpiredAt = new Date(now.getTime() - JOB_LEASE_DURATION_MS);
        const types = input.types ?? [
          "delete_session",
          "delete_artifact",
          "cleanup_artifact_object",
          "cleanup_drive_object",
          "cleanup_upload",
          "reconcile_session",
          "reconcile_personal_agent",
        ];
        const jobTypes = sql.join(
          types.map((type) => sql`${type}`),
          sql`, `,
        );
        const claimed = await db.transaction(async (transaction) => {
          await transaction.execute(
            sql`with exhausted as (
                  select id
                    from background_jobs
                   where status = 'running'
                     and locked_at <= ${leaseExpiredAt}
                     and type in (${jobTypes})
                     and attempts >= max_attempts
                   for update skip locked
                ),
                failed_jobs as (
                  update background_jobs job
                   set status = 'failed',
                       locked_at = null,
                       locked_by = null,
                       last_error = case
                         when job.type = 'delete_session'
                           then 'SESSION_DELETE_LEASE_EXPIRED'
                         when job.type = 'delete_artifact'
                           then 'ARTIFACT_DELETE_LEASE_EXPIRED'
                         when job.type = 'cleanup_artifact_object'
                           then 'ARTIFACT_CLEANUP_LEASE_EXPIRED'
                         when job.type = 'cleanup_drive_object'
                           then 'DRIVE_CLEANUP_LEASE_EXPIRED'
                         else coalesce(
                           job.last_error,
                           'Job lease expired after final attempt'
                         )
                       end,
                       updated_at = ${now}
                  from exhausted
                 where job.id = exhausted.id
                 returning job.id, job.owner_user_id, job.type
                ),
                failed_uploads as (
                  update session_inputs input
                     set status = 'failed',
                         last_error_code = 'Cleanup lease expired after final attempt',
                         updated_at = ${now}
                    from failed_jobs job
                   where job.type = 'cleanup_upload'
                     and input.id = job.id
                     and input.owner_user_id = job.owner_user_id
                     and input.session_id is null
                  returning input.id
                ),
                failed_artifacts as (
                  update artifacts artifact
                     set deletion_state = 'deletion_failed',
                         last_error_code = 'ARTIFACT_DELETE_LEASE_EXPIRED',
                         updated_at = ${now}
                    from failed_jobs job
                   where job.type = 'delete_artifact'
                     and artifact.id = job.id
                     and artifact.owner_user_id = job.owner_user_id
                  returning artifact.id
                ),
                failed_drive_files as (
                  update drive_files drive
                     set deletion_state = 'deletion_failed',
                         write_lease_until = null,
                         last_error_code = 'DRIVE_CLEANUP_LEASE_EXPIRED',
                         updated_at = ${now}
                    from failed_jobs job
                   where job.type = 'cleanup_drive_object'
                     and drive.id = job.id
                     and drive.owner_user_id = job.owner_user_id
                  returning drive.id
                ),
                failed_delete_sessions as (
                  update sessions session
                     set deletion_state = 'deletion_failed',
                         updated_at = ${now}
                    from failed_jobs job
                   where job.type = 'delete_session'
                     and session.id = job.id
                     and session.owner_user_id = job.owner_user_id
                  returning session.id
                ),
                failed_sessions as (
                  update sessions session
                     set status = 'terminated',
                         deletion_state = 'deletion_failed',
                         updated_at = ${now}
                    from failed_jobs job
                   where job.type = 'reconcile_session'
                     and session.id = job.id
                     and session.owner_user_id = job.owner_user_id
                  returning session.id, session.owner_user_id
                )
                update quota_reservations reservation
                   set status = case
                         when reservation.status = 'released'
                           then reservation.status
                         when reservation.ark_session_id like 'pending:%'
                           then 'unknown_outcome'::quota_reservation_status
                         else 'consumed'::quota_reservation_status
                       end,
                       resolved_at = case
                         when reservation.status = 'released'
                           then reservation.resolved_at
                         when reservation.ark_session_id like 'pending:%'
                           then null
                         else coalesce(reservation.resolved_at, ${now})
                       end
                  from failed_sessions session
                 where reservation.id = session.id
                   and reservation.user_id = session.owner_user_id`,
          );
          return rows<JobRecord>(
            transaction,
            sql`with claimable as (
                  select id
                    from background_jobs
                   where (
                         (status = 'pending' and run_after <= ${now})
                         or
                         (status = 'running' and locked_at <= ${leaseExpiredAt})
                       )
                     and type in (${jobTypes})
                     and attempts < max_attempts
                   order by priority asc, run_after asc, created_at asc, id asc
                   for update skip locked
                   limit ${input.limit}
                )
                update background_jobs job
                   set status = 'running',
                       locked_at = ${now},
                       locked_by = ${input.workerId},
                       attempts = job.attempts + 1,
                       lease_generation = job.lease_generation + 1,
                       updated_at = ${now}
                  from claimable
                 where job.id = claimable.id
                returning job.id,
                          job.owner_user_id as "ownerUserId",
                          job.type,
                          job.status,
                          job.priority,
                          job.payload,
                          job.attempts,
                          job.max_attempts as "maxAttempts",
                          job.run_after as "runAfter",
                          job.locked_at as "lockedAt",
                          job.locked_by as "lockedBy",
                          job.lease_generation as "leaseGeneration",
                          job.created_at as "createdAt"`,
          );
        });
        return claimed.sort(
          (left, right) =>
            left.priority - right.priority ||
            left.runAfter.getTime() - right.runAfter.getTime() ||
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        );
      },
      async succeed(id: string, workerId: string, leaseGeneration: number) {
        await db.execute(
          sql`update background_jobs
                set status = 'succeeded',
                    locked_at = null,
                    locked_by = null,
                    last_error = null,
                    updated_at = now()
              where id = ${id}
                and status = 'running'
                and locked_by = ${workerId}
                and lease_generation = ${leaseGeneration}`,
        );
      },
      /**
       * Extends the lease of still-owned running jobs. A count below the
       * input length means at least one job was taken over (or finished):
       * the caller must stop that job's further side effects immediately.
       */
      async heartbeat(
        input: {
          items: Array<{ id: string; leaseGeneration: number }>;
          workerId: string;
        },
        now = new Date(),
      ) {
        if (input.items.length === 0) return 0;
        const extended = await rows<{ id: string }>(
          db,
          sql`update background_jobs job
                 set locked_at = ${now}, updated_at = ${now}
                from (
                  values ${sql.join(
                    input.items.map(
                      (item) =>
                        sql`(${item.id}::uuid, ${item.leaseGeneration}::integer)`,
                    ),
                    sql`, `,
                  )}
                ) as claimed(id, lease_generation)
               where job.id = claimed.id
                 and job.status = 'running'
                 and job.locked_by = ${input.workerId}
                 and job.lease_generation = claimed.lease_generation
              returning job.id`,
        );
        return extended.length;
      },
      async succeedArtifactCleanup(
        id: string,
        workerId: string,
        cleanupGeneration: number,
        leaseGeneration: number,
      ) {
        const updated = await rows(
          db,
          sql`update background_jobs
                set status = 'succeeded',
                    locked_at = null,
                    locked_by = null,
                    last_error = null,
                    updated_at = now()
              where id = ${id}
                and type = 'cleanup_artifact_object'
                and status = 'running'
                and locked_by = ${workerId}
                and lease_generation = ${leaseGeneration}
                and coalesce(
                      (payload ->> 'cleanupGeneration')::integer,
                      0
                    ) = ${cleanupGeneration}
              returning id`,
        );
        return updated.length === 1;
      },
      async deferArtifactCleanup(
        id: string,
        workerId: string,
        cleanupGeneration: number,
        leaseGeneration: number,
      ) {
        const updated = await rows(
          db,
          sql`update background_jobs
                set status = 'pending',
                    attempts = greatest(attempts - 1, 0),
                    run_after = case
                      when payload ? 'uploadInProgressUntil'
                        then greatest(
                          now(),
                          (payload ->> 'uploadInProgressUntil')::timestamptz
                        )
                      else now()+interval '30 seconds'
                    end,
                    locked_at = null,
                    locked_by = null,
                    last_error = null,
                    updated_at = now()
              where id = ${id}
                and type = 'cleanup_artifact_object'
                and status = 'running'
                and locked_by = ${workerId}
                and lease_generation = ${leaseGeneration}
                and coalesce(
                      (payload ->> 'cleanupGeneration')::integer,
                      0
                    ) = ${cleanupGeneration}
              returning id`,
        );
        return updated.length === 1;
      },
      /**
       * Puts a fence-blocked delete_session job back to pending without
       * consuming an attempt: consolidation is progressing in this same
       * worker, so waiting is progress, not failure. A lost lease reports
       * false and the caller falls back to the retry path.
       */
      async deferSessionDeletion(
        id: string,
        workerId: string,
        runAfter: Date,
        leaseGeneration: number,
      ) {
        const updated = await rows(
          db,
          sql`update background_jobs
                 set status = 'pending',
                     attempts = greatest(attempts - 1, 0),
                     run_after = ${runAfter},
                     locked_at = null,
                     locked_by = null,
                     last_error = null,
                     updated_at = now()
               where id = ${id}
                 and type = 'delete_session'
                 and status = 'running'
                 and locked_by = ${workerId}
                 and lease_generation = ${leaseGeneration}
               returning id`,
        );
        return updated.length === 1;
      },
      async retryArtifactCleanup(
        id: string,
        workerId: string,
        cleanupGeneration: number,
        leaseGeneration: number,
        error: string,
        final: boolean,
        now = new Date(),
      ) {
        return db.transaction(async (transaction) => {
          const leased = await first<{ attempts: number }>(
            transaction,
            sql`select attempts
                  from background_jobs
                 where id = ${id}
                   and type = 'cleanup_artifact_object'
                   and status = 'running'
                   and locked_by = ${workerId}
                   and lease_generation = ${leaseGeneration}
                   and coalesce(
                         (payload ->> 'cleanupGeneration')::integer,
                         0
                       ) = ${cleanupGeneration}
                 for update`,
          );
          if (!leased) return false;
          const runAfter = new Date(
            now.getTime() + Math.min(60_000, 2 ** leased.attempts * 100),
          );
          const updated = await rows(
            transaction,
            sql`update background_jobs
                  set status = ${final ? "failed" : "pending"}::background_job_status,
                      run_after = ${runAfter},
                      locked_at = null,
                      locked_by = null,
                      last_error = ${artifactCleanupErrorCode(error)},
                      updated_at = ${now}
                where id = ${id}
                  and type = 'cleanup_artifact_object'
                  and status = 'running'
                  and locked_by = ${workerId}
                  and coalesce(
                        (payload ->> 'cleanupGeneration')::integer,
                        0
                      ) = ${cleanupGeneration}
                returning id`,
          );
          return updated.length === 1;
        });
      },
      async succeedDriveCleanup(
        id: string,
        workerId: string,
        cleanupGeneration: number,
        leaseGeneration: number,
      ) {
        const updated = await rows(
          db,
          sql`update background_jobs
                set status = 'succeeded',
                    locked_at = null,
                    locked_by = null,
                    last_error = null,
                    updated_at = now()
              where id = ${id}
                and type = 'cleanup_drive_object'
                and status = 'running'
                and locked_by = ${workerId}
                and lease_generation = ${leaseGeneration}
                and coalesce(
                      (payload ->> 'cleanupGeneration')::integer,
                      0
                    ) = ${cleanupGeneration}
              returning id`,
        );
        return updated.length === 1;
      },
      async deferDriveCleanup(
        id: string,
        workerId: string,
        cleanupGeneration: number,
        leaseGeneration: number,
      ) {
        const updated = await rows(
          db,
          sql`update background_jobs
                set status = 'pending',
                    attempts = greatest(attempts - 1, 0),
                    run_after = case
                      when payload ? 'uploadInProgressUntil'
                        then greatest(
                          now(),
                          (payload ->> 'uploadInProgressUntil')::timestamptz
                        )
                      else now()
                    end,
                    locked_at = null,
                    locked_by = null,
                    last_error = null,
                    updated_at = now()
              where id = ${id}
                and type = 'cleanup_drive_object'
                and status = 'running'
                and locked_by = ${workerId}
                and lease_generation = ${leaseGeneration}
                and coalesce(
                      (payload ->> 'cleanupGeneration')::integer,
                      0
                    ) = ${cleanupGeneration}
              returning id`,
        );
        return updated.length === 1;
      },
      async retryDriveCleanup(
        id: string,
        workerId: string,
        cleanupGeneration: number,
        leaseGeneration: number,
        error: string,
        final: boolean,
        now = new Date(),
      ) {
        return db.transaction(async (transaction) => {
          const leased = await first<{ attempts: number }>(
            transaction,
            sql`select attempts
                  from background_jobs
                 where id = ${id}
                   and type = 'cleanup_drive_object'
                   and status = 'running'
                   and locked_by = ${workerId}
                   and lease_generation = ${leaseGeneration}
                   and coalesce(
                         (payload ->> 'cleanupGeneration')::integer,
                         0
                       ) = ${cleanupGeneration}
                 for update`,
          );
          if (!leased) return false;
          const runAfter = new Date(
            now.getTime() + Math.min(60_000, 2 ** leased.attempts * 100),
          );
          const updated = await rows(
            transaction,
            sql`update background_jobs
                  set status = ${final ? "failed" : "pending"}::background_job_status,
                      run_after = ${runAfter},
                      locked_at = null,
                      locked_by = null,
                      last_error = ${driveCleanupErrorCode(error)},
                      updated_at = ${now}
                where id = ${id}
                  and type = 'cleanup_drive_object'
                  and status = 'running'
                  and locked_by = ${workerId}
                  and coalesce(
                        (payload ->> 'cleanupGeneration')::integer,
                        0
                      ) = ${cleanupGeneration}
                returning id`,
          );
          if (updated.length !== 1) return false;
          if (final) {
            await transaction.execute(
              sql`update drive_files
                    set deletion_state = 'deletion_failed',
                        write_lease_until = null,
                        last_error_code = ${driveCleanupErrorCode(error)},
                        updated_at = ${now}
                  where id = ${id}
                    and owner_user_id = (
                      select owner_user_id
                        from background_jobs
                       where id = ${id}
                    )
                    and deletion_state <> 'deleted'`,
            );
          }
          return true;
        });
      },
      async updatePayload(
        id: string,
        workerId: string,
        payload: Record<string, unknown>,
        leaseGeneration: number,
      ) {
        await requiredFirst(
          db,
          sql`update background_jobs
                set payload = ${JSON.stringify(payload)}::jsonb,
                    updated_at = now()
              where id = ${id}
                and type = 'delete_session'
                and status = 'running'
                and locked_by = ${workerId}
                and lease_generation = ${leaseGeneration}
              returning id`,
        );
      },
      async retry(
        id: string,
        workerId: string,
        error: string,
        final: boolean,
        leaseGeneration: number,
        now = new Date(),
      ) {
        const artifactError = artifactDeletionErrorCode(error);
        const artifactCleanupError = artifactCleanupErrorCode(error);
        const driveCleanupError = driveCleanupErrorCode(error);
        const sessionError = sessionDeletionErrorCode(error);
        await db.transaction(async (transaction) => {
          if (error === "ARTIFACT_SYNC_PAUSED") {
            // Discovery and completion acquire the session before turn/job.
            // A paused retry must follow the same order.
            await transaction.execute(sql`set local lock_timeout='5000'`);
            await transaction.execute(sql`select s.id from sessions s
              join session_turns t on t.session_id=s.id and t.owner_user_id=s.owner_user_id
              join background_jobs j on j.id=t.id and j.owner_user_id=t.owner_user_id
              where j.id=${id} and j.type='reconcile_session'
                and j.payload->>'operation'='sync_artifacts' for update of s`);
          }
          const leased = await first<{
            attempts: number;
            operation: string | null;
          }>(
            transaction,
            sql`select attempts,payload->>'operation' as operation
                  from background_jobs
                 where id = ${id}
                   and status = 'running'
                   and locked_by = ${workerId}
                   and lease_generation = ${leaseGeneration}
                 for update`,
          );
          if (!leased) return;
          if (
            error === "ARTIFACT_SYNC_PAUSED" &&
            leased.operation === "sync_artifacts"
          ) {
            // Keep a full retry window available after a deployment pauses
            // background delivery, including a long interval between polls.
            await transaction.execute(sql`update background_jobs j set payload=payload ||
              jsonb_build_object('artifactRetryWindowMs',coalesce(
                (payload->>'artifactRetryWindowMs')::bigint,
                (select greatest(1000,extract(epoch from retry_until-created_at)*1000)::bigint
                  from session_turns where id=j.id))) where j.id=${id}`);
            await transaction.execute(sql`update session_turns set retry_until=greatest(
              retry_until,${now}::timestamptz+
              (select (payload->>'artifactRetryWindowMs')::bigint from background_jobs where id=${id})*interval '1 millisecond')
              where id=${id} and artifact_state in ('pending','syncing','synced')`);
          }
          const runAfter = new Date(
            now.getTime() + Math.min(60_000, 2 ** leased.attempts * 100),
          );
          const syncDeferred = sql`type='reconcile_session' and payload->>'operation'='sync_artifacts'
            and ${error} in ('ARTIFACT_SYNC_PENDING','ARTIFACT_SYNC_PAUSED')`;
          const updated = await first<{
            id: string;
            ownerUserId: string | null;
            type: JobRecord["type"];
          }>(
            transaction,
            sql`update background_jobs
                  set status = case when (${syncDeferred}) or (type='reconcile_session' and payload->>'operation'='deliver' and ${error}='SUBMISSION_WAITING') then 'pending'::background_job_status else ${final ? "failed" : "pending"}::background_job_status end,
                      attempts = case when (${syncDeferred}) or (type='reconcile_session' and payload->>'operation'='deliver' and ${error}='SUBMISSION_WAITING') then greatest(attempts-1,0) else attempts end,
                      run_after = case when (${syncDeferred}) then ${new Date(now.getTime() + 10_000)}::timestamptz else ${runAfter}::timestamptz end,
                      locked_at = null,
                      locked_by = null,
                      last_error = case
                        when type = 'delete_session' then ${sessionError}
                        when type = 'delete_artifact' then ${artifactError}
                        when type = 'cleanup_artifact_object'
                          then ${artifactCleanupError}
                        when type = 'cleanup_drive_object'
                          then ${driveCleanupError}
                        else ${error}
                      end,
                      updated_at = ${now}
                where id = ${id}
                  and status = 'running'
                  and locked_by = ${workerId}
                  and lease_generation = ${leaseGeneration}
                returning id, owner_user_id as "ownerUserId", type`,
          );
          if (updated?.type === "cleanup_drive_object" && final) {
            await transaction.execute(
              sql`update drive_files
                    set deletion_state = 'deletion_failed',
                        write_lease_until = null,
                        last_error_code = ${driveCleanupError},
                        updated_at = ${now}
                  where id = ${updated.id}
                    and owner_user_id = ${updated.ownerUserId}
                    and deletion_state <> 'deleted'`,
            );
            return;
          }
          if (updated?.type === "cleanup_upload" && updated.ownerUserId) {
            await transaction.execute(
              sql`update session_inputs
                    set status = ${final ? "failed" : "deleting"}::upload_status,
                        last_error_code = ${error},
                        updated_at = ${now}
                  where id = ${updated.id}
                    and owner_user_id = ${updated.ownerUserId}
                    and session_id is null`,
            );
            return;
          }
          if (updated?.type === "delete_artifact" && updated.ownerUserId) {
            await transaction.execute(
              sql`update artifacts
                    set deletion_state = 'deletion_failed',
                        last_error_code = ${artifactError},
                        updated_at = ${now}
                  where id = ${updated.id}
                    and owner_user_id = ${updated.ownerUserId}`,
            );
            return;
          }
          if (updated?.type === "delete_session" && updated.ownerUserId) {
            await transaction.execute(
              sql`update sessions
                    set deletion_state = 'deletion_failed',
                        updated_at = ${now}
                  where id = ${updated.id}
                    and owner_user_id = ${updated.ownerUserId}`,
            );
            return;
          }
          if (
            !final ||
            updated?.type !== "reconcile_session" ||
            !updated.ownerUserId
          ) {
            return;
          }
          await transaction.execute(
            sql`update sessions
                  set status = 'terminated',
                      deletion_state = 'deletion_failed',
                      updated_at = ${now}
                where id = ${updated.id}
                  and owner_user_id = ${updated.ownerUserId}`,
          );
          await transaction.execute(
            sql`update quota_reservations
                  set status = case
                        when status = 'released' then status
                        when ark_session_id like 'pending:%'
                          then 'unknown_outcome'::quota_reservation_status
                        else 'consumed'::quota_reservation_status
                      end,
                      resolved_at = case
                        when status = 'released' then resolved_at
                        when ark_session_id like 'pending:%' then null
                        else coalesce(resolved_at, ${now})
                      end
                where id = ${updated.id}
                  and user_id = ${updated.ownerUserId}`,
          );
        });
      },
    },
  };
}
