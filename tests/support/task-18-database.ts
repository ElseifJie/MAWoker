import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createRepositories } from "../../packages/db/src/index.js";
import {
  ArtifactService,
  DriveFileService,
  SessionService,
} from "../../packages/domain/src/index.js";
import { InMemoryArtifactStorage } from "../../packages/storage/src/index.js";
import { createTestDatabase } from "./test-database.js";

export async function collectBytes(
  stream: NodeJS.ReadableStream,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

export async function createTask18DatabaseHarness() {
  const database = await createTestDatabase();
  const repositories = createRepositories(database.db);
  const storage = new InMemoryArtifactStorage();
  const adminId = randomUUID();
  const platformAgentId = randomUUID();
  const now = new Date();

  const first = {
    userId: randomUUID(),
    personalAgentId: randomUUID(),
    sessionId: randomUUID(),
    uploadId: randomUUID(),
    artifactId: randomUUID(),
    usageId: randomUUID(),
  };
  const second = {
    userId: randomUUID(),
    personalAgentId: randomUUID(),
    sessionId: randomUUID(),
    uploadId: randomUUID(),
    artifactId: randomUUID(),
    usageId: randomUUID(),
  };

  await database.client.query(
    `insert into users (id, auth_subject, email, role)
     values ($1, $2, 'admin@example.com', 'admin'),
            ($3, $4, 'user-a@example.com', 'user'),
            ($5, $6, 'user-b@example.com', 'user')`,
    [
      adminId,
      `managed:${adminId}`,
      first.userId,
      `managed:${first.userId}`,
      second.userId,
      `managed:${second.userId}`,
    ],
  );
  await database.client.query(
    `insert into quota_policies
       (key, personal_agent_limit, concurrent_session_limit,
        daily_session_limit, monthly_token_limit)
     values ('default', 10, 1, 25, 100)`,
  );
  await database.client.query(
    `insert into platform_agents
       (id, ark_agent_id, name, description, model_id, system_prompt,
        ark_version, status, created_by, updated_by)
     values ($1, 'ark-platform-task-18', 'Platform Agent', '',
             'model-a', 'Prompt', '1', 'active', $2, $2)`,
    [platformAgentId, adminId],
  );
  await database.client.query(
    `insert into user_default_agents
       (user_id, platform_agent_id, assigned_by)
     values ($1, $2, $3)`,
    [first.userId, platformAgentId, adminId],
  );

  async function seedTenant(tenant: typeof first, ordinal: "first" | "second") {
    const arkAgentId = `ark-agent-${ordinal}`;
    const arkSessionId = `ark-session-${ordinal}`;
    const arkFileId = `ark-file-${ordinal}`;
    const driveFileId = randomUUID();
    const objectKey = `tenants/${tenant.userId}/drive/artifact/${driveFileId}/${ordinal}.txt`;
    const bytes = new TextEncoder().encode(`${ordinal} artifact`);

    await database.client.query(
      `insert into personal_agents
         (id, owner_user_id, ark_agent_id, name, description, model_id,
          system_prompt, ark_version, status)
       values ($1, $2, $3, $4, '', 'model-a', 'Prompt', '1', 'active')`,
      [tenant.personalAgentId, tenant.userId, arkAgentId, `${ordinal} Agent`],
    );
    await database.client.query(
      `insert into sessions
         (id, owner_user_id, ark_session_id, agent_kind, personal_agent_id,
          ark_agent_id, agent_name, agent_version, environment_id, title,
          status, created_at, updated_at)
       values ($1, $2, $3, 'personal', $4, $5, $6, '1', 'environment-1',
               $7, 'idle', $8, $8)`,
      [
        tenant.sessionId,
        tenant.userId,
        arkSessionId,
        tenant.personalAgentId,
        arkAgentId,
        `${ordinal} Agent`,
        `${ordinal} Session`,
        now,
      ],
    );
    await database.client.query(
      `insert into session_inputs
         (id, owner_user_id, session_id, ark_file_id, original_name,
          mime_type, size_bytes, mount_path, status, expires_at)
       values ($1, $2, $3, $4, 'input.txt', 'text/plain', 5, $5, 'bound', $6)`,
      [
        tenant.uploadId,
        tenant.userId,
        tenant.sessionId,
        `ark-input-${ordinal}`,
        `/mnt/session/inputs/${tenant.uploadId}-input.txt`,
        new Date(now.getTime() + 60_000),
      ],
    );
    await database.client.query(
      `insert into drive_files
         (id, owner_user_id, origin, tos_object_key, name, mime_type, size_bytes,
          source_session_id, deletion_state, created_at, updated_at)
       values ($1, $2, 'artifact', $3, 'result.txt', 'text/plain', $4, $5,
               'none', $6, $6)`,
      [
        driveFileId,
        tenant.userId,
        objectKey,
        bytes.byteLength,
        tenant.sessionId,
        now,
      ],
    );
    await database.client.query(
      `insert into artifacts
         (id, owner_user_id, session_id, ark_file_id, drive_file_id, name,
          mime_type, size_bytes, generated_at)
       values ($1, $2, $3, $4, $5, 'result.txt', 'text/plain', $6, $7)`,
      [
        tenant.artifactId,
        tenant.userId,
        tenant.sessionId,
        arkFileId,
        driveFileId,
        bytes.byteLength,
        now,
      ],
    );
    await storage.write(objectKey, Readable.from([bytes]), {
      contentType: "text/plain",
      contentLength: bytes.byteLength,
    });
    await database.client.query(
      `insert into usage_ledger
         (id, user_id, ark_session_id, ark_event_id, metric_type, quantity,
          recorded_at)
       values ($1, $2, $3, $4, 'input_tokens', $5, $6)`,
      [
        tenant.usageId,
        tenant.userId,
        arkSessionId,
        `ark-event-${ordinal}`,
        ordinal === "first" ? 100 : 1,
        now,
      ],
    );
  }

  await seedTenant(first, "first");
  await seedTenant(second, "second");

  const sessions = new SessionService({
    repository: repositories.sessionLifecycle,
    agentResolver: {} as never,
    ark: {} as never,
    environmentId: "environment-1",
    createId: randomUUID,
  });
  const drive = new DriveFileService({
    repository: repositories.driveFiles,
    storage,
    createId: randomUUID,
  });
  const artifacts = new ArtifactService({
    repository: repositories.artifacts,
    drive,
    ark: {} as never,
    storage,
    createId: randomUUID,
  });

  return {
    database,
    repositories,
    storage,
    drive,
    sessions,
    artifacts,
    adminId,
    platformAgentId,
    first,
    second,
    ids: randomUUID,
    close: () => database.close(),
  };
}
