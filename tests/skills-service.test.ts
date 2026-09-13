import { describe, expect, it, vi } from "vitest";
import { InMemoryArkGateway } from "../packages/ark-client/src/index.js";
import {
  InvalidSkillPackageError,
  ResourceNotFoundError,
  SkillNotSelectableError,
  SkillService,
  type AgentSkillBinding,
  type SkillRecord,
  type SkillRepository,
} from "../packages/domain/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";
const requestId = "req-skills";

function zip(name = "demo.zip"): { name: string; contentType: string; bytes: Uint8Array } {
  return { name, contentType: "application/zip", bytes: new Uint8Array([80, 75]) };
}

function skillRecord(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    ownerUserId: userId,
    arkSkillId: "skill-1",
    name: "demo",
    displayTitle: "Demo",
    description: "",
    latestVersion: "1",
    source: "custom",
    fileName: "demo.zip",
    fileSize: 2,
    status: "active",
    lastErrorCode: null,
    createdAt: new Date("2026-09-12T00:00:00Z"),
    updatedAt: new Date("2026-09-12T00:00:00Z"),
    ...overrides,
  };
}

function createRepository(initial: SkillRecord[] = []) {
  const skills = new Map(initial.map((skill) => [skill.id, skill]));
  const repository: SkillRepository = {
    async findOwned(owner, id) {
      const skill = skills.get(id);
      return skill?.ownerUserId === owner ? skill : undefined;
    },
    async findPlatform(id) {
      const skill = skills.get(id);
      return skill?.ownerUserId === null ? skill : undefined;
    },
    async listForOwner(owner) {
      return [...skills.values()]
        .filter((skill) => skill.ownerUserId === owner)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    async listPlatform() {
      return [...skills.values()].filter(
        (skill) => skill.ownerUserId === null,
      );
    },
    async listActiveBindingsForOwner(owner) {
      return [...skills.values()]
        .filter((skill) => skill.ownerUserId === owner && skill.status === "active")
        .map((skill) => ({
          skillId: skill.id,
          arkSkillId: skill.arkSkillId,
          arkVersion: skill.latestVersion,
        }));
    },
    async findActiveByName(owner, name, excludeId) {
      return [...skills.values()].find(
        (skill) =>
          skill.ownerUserId === owner &&
          skill.name === name &&
          skill.status === "active" &&
          skill.id !== excludeId,
      );
    },
    async findSelectableBindings(owner, skillIds) {
      return [...skills.values()]
        .filter(
          (skill) =>
            skill.status === "active" &&
            (skill.ownerUserId === owner || skill.ownerUserId === null) &&
            skillIds.includes(skill.id),
        )
        .map((skill) => ({
          skillId: skill.id,
          arkSkillId: skill.arkSkillId,
          arkVersion: skill.latestVersion,
        }));
    },
    async createProvisioning(record) {
      const created: SkillRecord = {
        ...record,
        arkSkillId: `pending:${record.id}`,
        name: "",
        latestVersion: "0",
        source: "custom",
        status: "provisioning",
        lastErrorCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      skills.set(record.id, created);
      return created;
    },
    async markProvisioned(id, upstream) {
      const current = skills.get(id)!;
      const updated = { ...current, ...upstream, status: "active" as const, lastErrorCode: null };
      skills.set(id, updated);
      return updated;
    },
    async markFailure(id, status, errorCode) {
      const current = skills.get(id)!;
      const updated = { ...current, status, lastErrorCode: errorCode };
      skills.set(id, updated);
      return updated;
    },
    async updateMetadata(id, input) {
      const current = skills.get(id)!;
      const updated = {
        ...current,
        ...(input.displayTitle !== undefined ? { displayTitle: input.displayTitle } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      };
      skills.set(id, updated);
      return updated;
    },
    async replaceUpstream(id, upstream, file) {
      const current = skills.get(id)!;
      const updated = {
        ...current,
        ...upstream,
        fileName: file.fileName,
        fileSize: file.fileSize,
        status: "active" as const,
        lastErrorCode: null,
      };
      skills.set(id, updated);
      return updated;
    },
    async remove(id) {
      skills.delete(id);
    },
    async audit() {},
  };
  return { repository, skills };
}

function createSync() {
  const calls: Array<{
    kind: "ensure" | "unbind";
    userId?: string;
    bindings?: AgentSkillBinding[];
    skillId?: string;
  }> = [];
  return {
    calls,
    ensureAndBind: vi.fn(async (owner: string, bindings: AgentSkillBinding[]) => {
      calls.push({ kind: "ensure", userId: owner, bindings });
    }),
    unbindEverywhere: vi.fn(async (skillId: string) => {
      calls.push({ kind: "unbind", skillId });
    }),
  };
}

function createService(
  repository: SkillRepository,
  ark = new InMemoryArkGateway(),
  sync = createSync(),
) {
  return {
    ark,
    sync,
    service: new SkillService({
      repository,
      ark,
      defaultAgents: sync,
      createId: (() => {
        let n = 100;
        return () => `00000000-0000-4000-8000-0000000000${(n += 1)}`;
      })(),
    }),
  };
}

describe("SkillService", () => {
  it("uploads a package, provisions it in Ark, and syncs the default Agent", async () => {
    const state = createRepository();
    const { service, ark, sync } = createService(state.repository);

    const { skill, defaultAgentSync } = await service.upload(
      { file: zip(), displayTitle: "Demo Skill" },
      { userId, requestId },
    );

    expect(skill).toMatchObject({
      displayTitle: "Demo Skill",
      status: "active",
      arkSkillId: "skill-1",
      latestVersion: "1",
    });
    expect(defaultAgentSync).toEqual({ synced: true });
    expect(ark.calls[0]).toMatchObject({
      operation: "createSkill",
      input: { name: "demo.zip", displayTitle: "Demo Skill" },
    });
    // The sync carries every active owned Skill, pinned to its version.
    expect(sync.ensureAndBind).toHaveBeenCalledWith(
      userId,
      [{ skillId: skill.id, arkSkillId: "skill-1", arkVersion: "1" }],
      { userId, requestId },
    );
  });

  it("re-uploading the same package replaces the owner's row instead of duplicating", async () => {
    const existing = skillRecord({ name: "support-triage" });
    const state = createRepository([existing]);
    const ark = new InMemoryArkGateway();
    await ark.createSkill({
      file: { name: "seed.zip", contentType: "application/zip", bytes: new Uint8Array([1]) },
    });
    const { service } = createService(state.repository, ark);

    const { skill, defaultAgentSync } = await service.upload(
      { file: zip(), displayTitle: "Support Triage" },
      { userId, requestId },
    );

    // The freshly uploaded Ark package is attached to the existing row and the
    // throwaway row is gone: one active row per (owner, skill name).
    expect(defaultAgentSync).toEqual({ synced: true });
    expect([...state.skills.values()].filter((s) => s.status === "active"))
      .toHaveLength(1);
    expect(skill.id).toBe(existing.id);
    expect(skill).toMatchObject({
      arkSkillId: "skill-2",
      name: "support-triage",
      displayTitle: "Support Triage",
      latestVersion: "1",
      status: "active",
    });
  });

  it("rejects non-zip packages without touching Ark", async () => {
    const state = createRepository();
    const { service, ark } = createService(state.repository);

    await expect(
      service.upload(
        { file: { name: "skill.txt", contentType: "text/plain", bytes: new Uint8Array([1]) } },
        { userId, requestId },
      ),
    ).rejects.toBeInstanceOf(InvalidSkillPackageError);
    expect(ark.calls).toHaveLength(0);
  });

  it("marks the Skill failed when Ark rejects the upload", async () => {
    const state = createRepository();
    const ark = new InMemoryArkGateway();
    ark.failNext("createSkill", "not_found");
    const { service, sync } = createService(state.repository, ark);

    await expect(
      service.upload({ file: zip() }, { userId, requestId }),
    ).rejects.toMatchObject({ category: "not_found" });
    expect([...state.skills.values()][0]).toMatchObject({
      status: "failed",
      lastErrorCode: "ARK_NOT_FOUND",
    });
    expect(sync.ensureAndBind).not.toHaveBeenCalled();
  });

  it("rebinds the default Agent after a metadata edit and a package replacement", async () => {
    const existing = skillRecord();
    const state = createRepository([existing]);
    const ark = new InMemoryArkGateway();
    // Bump the stub counter so the replacement package gets a fresh id.
    await ark.createSkill({ file: { name: "seed.zip", contentType: "application/zip", bytes: new Uint8Array([1]) } });
    const { service, sync } = createService(state.repository, ark);

    await service.update(
      existing.id,
      { displayTitle: "Renamed", description: "Updated" },
      { userId, requestId },
    );
    expect(state.skills.get(existing.id)).toMatchObject({
      displayTitle: "Renamed",
      description: "Updated",
      arkSkillId: "skill-1",
    });

    await service.update(existing.id, { file: zip("v2.zip") }, { userId, requestId });
    const updated = state.skills.get(existing.id)!;
    expect(updated.arkSkillId).toBe("skill-2");
    expect(updated.fileName).toBe("v2.zip");
    expect(updated.status).toBe("active");
    expect(sync.ensureAndBind).toHaveBeenCalledTimes(2);
  });

  it("unbinds the Skill everywhere and removes the row on delete", async () => {
    const existing = skillRecord();
    const state = createRepository([existing]);
    const { service, sync } = createService(state.repository);

    const result = await service.delete(existing.id, { userId, requestId });

    expect(result).toEqual({ synced: true });
    expect(sync.unbindEverywhere).toHaveBeenCalledWith(existing.id);
    expect(state.skills.has(existing.id)).toBe(false);
    // Removing the last Skill leaves the default Agent bound to an empty list.
    expect(sync.ensureAndBind).toHaveBeenCalledWith(userId, [], {
      userId,
      requestId,
    });
  });

  it("keeps the Skill mutation successful when the default Agent sync fails", async () => {
    const state = createRepository();
    const ark = new InMemoryArkGateway();
    const sync = createSync();
    sync.ensureAndBind.mockRejectedValue(
      Object.assign(new Error("quota"), { code: "QUOTA_EXCEEDED" }),
    );
    const { service } = createService(state.repository, ark, sync);

    const { skill, defaultAgentSync } = await service.upload(
      { file: zip() },
      { userId, requestId },
    );
    expect(skill.status).toBe("active");
    expect(defaultAgentSync).toEqual({ synced: false, errorCode: "QUOTA_EXCEEDED" });
  });

  it("lists owned skills separately from platform presets", async () => {
    const owned = skillRecord();
    const preset = skillRecord({
      id: "00000000-0000-4000-8000-000000000020",
      ownerUserId: null,
      displayTitle: "Preset",
    });
    const state = createRepository([owned, preset]);
    const { service } = createService(state.repository);

    expect(
      (await service.list(userId, { scope: "custom" })).map((s) => s.id),
    ).toEqual([owned.id]);
    expect(
      (await service.list(userId, { scope: "preset" })).map((s) => s.id),
    ).toEqual([preset.id]);
  });

  it("resolves selected bindings and rejects skills the user cannot bind", async () => {
    const owned = skillRecord();
    const preset = skillRecord({
      id: "00000000-0000-4000-8000-000000000020",
      ownerUserId: null,
    });
    const other = skillRecord({
      id: "00000000-0000-4000-8000-000000000030",
      ownerUserId: "00000000-0000-4000-8000-000000000099",
    });
    const state = createRepository([owned, preset, other]);
    const { service } = createService(state.repository);

    expect(
      await service.resolveBindings(userId, [owned.id, preset.id, owned.id]),
    ).toEqual([
      { skillId: owned.id, arkSkillId: "skill-1", arkVersion: "1" },
      { skillId: preset.id, arkSkillId: "skill-1", arkVersion: "1" },
    ]);
    await expect(
      service.resolveBindings(userId, [owned.id, other.id]),
    ).rejects.toBeInstanceOf(SkillNotSelectableError);
  });

  it("does not let a user edit or delete a platform preset through the user path", async () => {
    const preset = skillRecord({ id: "00000000-0000-4000-8000-000000000020", ownerUserId: null });
    const state = createRepository([preset]);
    const { service } = createService(state.repository);

    await expect(
      service.update(preset.id, { displayTitle: "Hijack" }, { userId, requestId }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(
      service.delete(preset.id, { userId, requestId }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
