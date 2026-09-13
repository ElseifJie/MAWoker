import { describe, expect, it } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";
import { UserDefaultAgentSynchronizer, UserAgentService } from "../packages/domain/src/index.js";
import { createTestDatabase, id } from "./support/test-database.js";

async function seedUsers(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
) {
  const adminId = id();
  const userId = id();
  await client.query(
    `insert into users (id, auth_subject, email, role)
     values ($1, $2, 'admin@example.com', 'admin'),
            ($3, $4, 'user@example.com', 'user')`,
    [adminId, `admin-${adminId}`, userId, `user-${userId}`],
  );
  await client.query(
    `insert into quota_policies
      (key, personal_agent_limit, concurrent_session_limit,
       daily_session_limit, monthly_token_limit)
     values ('default', 5, 2, 20, 1000)`,
  );
  return { adminId, userId };
}

async function seedPlatformAgent(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
  adminId: string,
) {
  const platformAgentId = id();
  await client.query(
    `insert into platform_agents
      (id, ark_agent_id, name, model_id, system_prompt, ark_version, status,
       created_by, updated_by)
     values ($1, 'ark-platform', 'Platform', 'model-a', 'Platform prompt',
             '2', 'active', $2, $2)`,
    [platformAgentId, adminId],
  );
  return platformAgentId;
}

async function seedSkill(
  client: Awaited<ReturnType<typeof createTestDatabase>>["client"],
  ownerUserId: string | null,
  overrides: Partial<{ displayTitle: string; arkSkillId: string; status: string }> = {},
) {
  const skillId = id();
  await client.query(
    `insert into skills
      (id, owner_user_id, ark_skill_id, name, display_title, latest_version,
       source, file_name, file_size, status)
     values ($1, $2, $3, $4, $5, '1', 'custom', 'demo.zip', 2, $6)`,
    [
      skillId,
      ownerUserId,
      overrides.arkSkillId ?? `ark-skill-${skillId}`,
      "demo",
      overrides.displayTitle ?? "Demo",
      overrides.status ?? "active",
    ],
  );
  return skillId;
}

describe("skills database integration", () => {
  it("persists skills, rewrites bindings, and keeps one auto-default Agent per user", async () => {
    const database = await createTestDatabase();
    const { adminId, userId } = await seedUsers(database.client);
    const platformAgentId = await seedPlatformAgent(database.client, adminId);
    await database.client.query(
      `insert into user_default_agents (user_id, platform_agent_id, assigned_by)
       values ($1, $2, $3)`,
      [userId, platformAgentId, adminId],
    );

    const repositories = createRepositories(database.db);
    let arkVersionCounter = 1;
    const ark = {
      createAgent: () => ({ id: `ark-agent-${id()}`, version: 1 }),
      updateAgent: () => ({ id: "ignored", version: ++arkVersionCounter }),
      deleteAgent: () => {},
    };
    const userAgents = new UserAgentService({
      repository: repositories.userAgents,
      ark: ark as never,
      modelAllowlist: ["model-a"],
      createId: id,
    });

    // Provision a Skill, then let the synchronizer materialize the default Agent.
    const firstSkill = await repositories.skills.createProvisioning({
      id: id(),
      ownerUserId: userId,
      displayTitle: "Demo",
      description: "",
      fileName: "demo.zip",
      fileSize: 2,
    });
    await repositories.skills.markProvisioned(firstSkill.id, {
      arkSkillId: "ark-skill-demo",
      name: "demo",
      latestVersion: "1",
      source: "custom",
    });

    const synchronizer = new UserDefaultAgentSynchronizer(userAgents);
    const context = { userId, requestId: "req-db-sync" };
    let bindings = await repositories.skills.listActiveBindingsForOwner(userId);
    expect(bindings).toEqual([
      { skillId: firstSkill.id, arkSkillId: "ark-skill-demo", arkVersion: "1" },
    ]);
    await synchronizer.ensureAndBind(userId, bindings, context);

    const autoDefault = await repositories.userAgents.findAutoDefault(userId);
    expect(autoDefault).toMatchObject({
      ownerUserId: userId,
      isAutoDefault: true,
      status: "active",
    });
    expect(autoDefault?.skills).toEqual([
      { skillId: firstSkill.id, arkSkillId: "ark-skill-demo", arkVersion: "1" },
    ]);
    expect(autoDefault?.modelId).toBe("model-a");

    // The default Agent is available and flagged in the workspace listing.
    const available = await repositories.userAgents.listAvailable(userId);
    const personalEntry = available.find((agent) => agent.id === autoDefault?.id);
    expect(personalEntry).toMatchObject({
      kind: "personal",
      editable: true,
      isAutoDefault: true,
    });
    expect(personalEntry?.skills).toEqual([
      { id: firstSkill.id, displayTitle: "Demo" },
    ]);

    // Rewriting the binding replaces the junction rows wholesale.
    const secondSkill = await repositories.skills.createProvisioning({
      id: id(),
      ownerUserId: userId,
      displayTitle: "Second",
      description: "",
      fileName: "second.zip",
      fileSize: 3,
    });
    await repositories.skills.markProvisioned(secondSkill.id, {
      arkSkillId: "ark-skill-second",
      name: "second",
      latestVersion: "4",
      source: "custom",
    });
    bindings = await repositories.skills.listActiveBindingsForOwner(userId);
    await synchronizer.ensureAndBind(userId, bindings, context);
    const rebound = await repositories.userAgents.findAutoDefault(userId);
    expect(rebound?.skills.map((skill) => skill.arkSkillId).sort()).toEqual([
      "ark-skill-demo",
      "ark-skill-second",
    ]);

    // A second auto-default Agent for the same user violates the partial index.
    await expect(
      database.client.query(
        `insert into personal_agents
          (id, owner_user_id, ark_agent_id, name, model_id, system_prompt,
           ark_version, status, is_auto_default)
         values ($1, $2, 'ark-dup', 'Dup', 'model-a', 'Prompt', '1', 'active', true)`,
        [id(), userId],
      ),
    ).rejects.toThrow(/personal_agents_owner_auto_default_unique/);

    // The (owner, skill name) pair is the storage identity: a second active
    // Skill with the same package name violates the unique index. The service
    // layer replaces the existing row on re-upload instead of hitting this.
    await expect(
      database.client.query(
        `insert into skills
          (id, owner_user_id, ark_skill_id, name, display_title,
           latest_version, source, file_name, file_size, status)
         values ($1, $2, 'ark-skill-demo-v2', 'demo', 'Demo v2', '2',
                 'custom', 'demo.zip', 4, 'active')`,
        [id(), userId],
      ),
    ).rejects.toThrow(/skills_owner_name_active_unique/);
    bindings = await repositories.skills.listActiveBindingsForOwner(userId);
    expect(bindings.map((binding) => binding.arkSkillId).sort()).toEqual([
      "ark-skill-demo",
      "ark-skill-second",
    ]);

    // Deleting a Skill cascades the binding rows.
    await repositories.skills.remove(secondSkill.id);
    expect(rebound?.skills).toHaveLength(2);
    const afterDelete = await repositories.userAgents.findAutoDefault(userId);
    expect(afterDelete?.skills.map((skill) => skill.arkSkillId)).toEqual([
      "ark-skill-demo",
    ]);

    // listAgentsBoundToSkill spans owners and feeds the unbind flow. The
    // Agent still carries the pre-dedup binding until the next sync runs.
    const bound = await repositories.userAgents.listAgentsBoundToSkill(firstSkill.id);
    expect(bound.map((agent) => agent.id)).toEqual([autoDefault?.id]);
    await database.close();
  });

  it("resolves selectable bindings for own and preset skills only", async () => {
    const database = await createTestDatabase();
    const { adminId, userId } = await seedUsers(database.client);
    const foreignUserId = id();
    await database.client.query(
      `insert into users (id, auth_subject, email, role)
       values ($1, $2, 'foreign@example.com', 'user')`,
      [foreignUserId, `foreign-${foreignUserId}`],
    );
    void adminId;
    const owned = await seedSkill(database.client, userId, {
      displayTitle: "Owned",
      arkSkillId: "ark-owned",
    });
    const preset = await seedSkill(database.client, null, {
      displayTitle: "Preset",
      arkSkillId: "ark-preset",
    });
    const foreign = await seedSkill(database.client, foreignUserId, {
      displayTitle: "Foreign",
      arkSkillId: "ark-foreign",
    });
    await database.client.query(
      `insert into skills (id, owner_user_id, ark_skill_id, name, display_title,
                           latest_version, source, file_name, file_size, status)
       values ($1, $2, 'ark-provisioning', 'p', 'Provisioning', '1', 'custom',
               'p.zip', 1, 'provisioning')`,
      [id(), userId],
    );

    const repositories = createRepositories(database.db);
    const selectable = await repositories.skills.findSelectableBindings(userId, [
      owned,
      preset,
      foreign,
    ]);
    expect(
      selectable.map((binding) => binding.arkSkillId).sort(),
    ).toEqual(["ark-owned", "ark-preset"]);

    expect(
      (await repositories.skills.listForOwner(userId, null))
        .map((s) => s.displayTitle)
        .sort(),
    ).toEqual(["Owned", "Provisioning"]);
    expect(
      (await repositories.skills.listPlatform(null)).map((s) => s.displayTitle),
    ).toEqual(["Preset"]);
    expect(
      (await repositories.skills.listForOwner(userId, "own")).map((s) => s.id),
    ).toEqual([owned]);

    const userAgents = await repositories.adminAgents.listUserAgents();
    expect(userAgents).toEqual([]);
    await database.close();
  });
});
