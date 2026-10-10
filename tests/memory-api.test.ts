import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "@pwa/auth";
import {
  AUTH_COOKIE_NAME,
  buildApp,
  type ApiAuthService,
} from "../apps/api/src/app.js";
import type {
  MemoryService,
  MemoryState,
} from "../packages/domain/src/memory.js";
import { capacity, MemoryError } from "../packages/domain/src/memory-policy.js";

const auth: ApiAuthService = {
  login: vi.fn(),
  renew: vi.fn(async () => ({ expiresAt: new Date(Date.now() + 60_000) })),
  logout: vi.fn(),
  async authenticate(token) {
    if (!["A", "B", "admin"].includes(token ?? ""))
      throw new AuthRequiredError();
    return {
      userId: token!,
      authSubject: `local:${token}`,
      role: token === "admin" ? "admin" : "user",
    };
  },
};
function state(userId = "A"): MemoryState {
  return {
    userId,
    revision: 1,
    status: "active",
    storeId: "private-store",
    policyEpoch: 1,
    protectedPaths: ["/memories/profile.md"],
    revokedPaths: [],
    autoDream: true,
    lastMonitorAt: 0,
    lastCompactAt: 0,
    run: {
      kind: "edit",
      stage: "queued",
      epoch: 1,
      baseline: [],
      snapshotId: "private-snapshot",
      candidateId: "private-candidate",
      dreamId: "private-dream",
      sources: [
        {
          id: "private-session",
          fingerprint: "secret",
          text: "private-source",
        },
      ],
      steps: [],
      error: null,
      before: null,
      after: null,
      pendingOperation: null,
    },
  };
}
function service() {
  return {
    list: vi.fn(async (userId: string) => {
      const entries = [
        {
          id: "private-entry",
          path: "/memories/profile.md",
          content: `${userId} profile`,
          storeId: "private-store",
        },
      ];
      return { entries, capacity: capacity(entries), state: state(userId) };
    }),
    status: vi.fn(async (userId: string) => state(userId)),
    write: vi.fn(async () => state()),
    remove: vi.fn(async () => state()),
    protect: vi.fn(async () => {}),
    dream: vi.fn(async () => state()),
    compress: vi.fn(async () => state()),
    settings: vi.fn(async () => {}),
  } satisfies Pick<
    MemoryService,
    | "list"
    | "status"
    | "write"
    | "remove"
    | "protect"
    | "dream"
    | "compress"
    | "settings"
  >;
}
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup(memory = service()) {
  const app = buildApp({ auth, memory });
  apps.push(app);
  return { app, memory, cookies: { [AUTH_COOKIE_NAME]: "A" } };
}
const routes = [
  { method: "GET", url: "/api/v1/memory" },
  { method: "GET", url: "/api/v1/memory/status" },
  {
    method: "POST",
    url: "/api/v1/memory/entry",
    payload: { path: "/memories/a.md", content: "hello" },
  },
  {
    method: "DELETE",
    url: "/api/v1/memory/entry",
    payload: { path: "/memories/a.md" },
  },
  {
    method: "POST",
    url: "/api/v1/memory/protect",
    payload: { path: "/memories/a.md", protected: true },
  },
  { method: "POST", url: "/api/v1/memory/dream" },
  { method: "POST", url: "/api/v1/memory/compress" },
  {
    method: "PATCH",
    url: "/api/v1/memory/settings",
    payload: { autoDream: false },
  },
] as const;

describe("personal memory API", () => {
  it("uses authenticated A/B identities and projects only public data", async () => {
    const { app, memory } = setup();
    for (const token of ["A", "B"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/memory",
        cookies: { [AUTH_COOKIE_NAME]: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        entries: [
          { path: "/memories/profile.md", content: `${token} profile` },
        ],
        capacity: capacity([{ id: "", path: "", content: `${token} profile` }]),
        state: {
          status: "active",
          protectedPaths: ["/memories/profile.md"],
          autoDream: true,
          run: {
            kind: "edit",
            stage: "queued",
            error: null,
            before: null,
            after: null,
          },
        },
      });
      expect(memory.list).toHaveBeenLastCalledWith(token);
      expect(response.body).not.toContain("private");
      expect(response.body).not.toMatch(
        /userId|storeId|baseline|steps|sources/,
      );
    }
  });
  it("authenticates all routes and hides them from administrators", async () => {
    const { app, memory } = setup();
    for (const route of routes) {
      expect((await app.inject(route)).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            ...route,
            cookies: { [AUTH_COOKIE_NAME]: "admin" },
          })
        ).statusCode,
      ).toBe(404);
    }
    for (const method of Object.values(memory))
      expect(method).not.toHaveBeenCalled();
  });
  it("dispatches queued mutations and returns sanitized status", async () => {
    const { app, memory, cookies } = setup();
    for (const route of routes.slice(2)) {
      const response = await app.inject({ ...route, cookies });
      expect(response.statusCode).toBe(
        ["/api/v1/memory/protect", "/api/v1/memory/settings"].includes(
          route.url,
        )
          ? 200
          : 202,
      );
      expect(response.body).not.toContain("private");
      expect(response.body).not.toMatch(
        /userId|storeId|baseline|steps|sources/,
      );
    }
    expect(memory.write).toHaveBeenCalledWith("A", {
      path: "/memories/a.md",
      content: "hello",
    });
    expect(memory.remove).toHaveBeenCalledWith("A", "/memories/a.md");
    expect(memory.protect).toHaveBeenCalledWith("A", "/memories/a.md", true);
    expect(memory.dream).toHaveBeenCalledWith("A");
    expect(memory.compress).toHaveBeenCalledWith("A");
    expect(memory.settings).toHaveBeenCalledWith("A", false);
    const response = await app.inject({ ...routes[1], cookies });
    expect(response.json()).toEqual({
      status: "active",
      protectedPaths: ["/memories/profile.md"],
      autoDream: true,
      run: {
        kind: "edit",
        stage: "queued",
        error: null,
        before: null,
        after: null,
      },
    });
  });
  it("passes expectedHash without allowing arbitrary authority or malformed bodies", async () => {
    const { app, memory, cookies } = setup();
    const payload = {
      path: "/memories/a.md",
      content: "hello",
      expectedHash: "hash",
    };
    expect(
      (await app.inject({ ...routes[2], cookies, payload })).statusCode,
    ).toBe(202);
    expect(memory.write).toHaveBeenCalledWith("A", payload);
    memory.write.mockClear();
    for (const route of routes.slice(2)) {
      expect(
        (
          await app.inject({
            ...route,
            cookies,
            payload: {
              ...("payload" in route ? route.payload : {}),
              storeId: "B-store",
            },
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const payload of [
      {},
      { path: 5, content: "x" },
      { path: "/memories/a.md" },
      { path: "/memories/a.md", content: "x", expectedHash: 5 },
    ]) {
      expect(
        (await app.inject({ ...routes[2], cookies, payload })).statusCode,
      ).toBe(400);
    }
    expect(memory.write).not.toHaveBeenCalled();
  });
  it.each([
    ["MEMORY_BUSY", 409],
    ["MEMORY_CONFLICT", 409],
    ["MEMORY_INVALID", 400],
    ["MEMORY_CAPACITY", 413],
    ["MEMORY_REPAIR_REQUIRED", 503],
  ] as const)(
    "maps %s without exposing raw exception text",
    async (code, status) => {
      const { app, memory, cookies } = setup();
      memory.write.mockRejectedValueOnce(
        new MemoryError(code, "private-store private-source"),
      );
      const response = await app.inject({ ...routes[2], cookies });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe(code);
      expect(response.body).not.toContain("private");
    },
  );
  it("reports capability only when a memory service is configured", async () => {
    const { app, cookies } = setup();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/capabilities",
          cookies,
        })
      ).json().memoryStores,
    ).toEqual({ available: true });
    const unavailable = buildApp({ auth });
    apps.push(unavailable);
    expect(
      (
        await unavailable.inject({
          method: "GET",
          url: "/api/v1/capabilities",
          cookies,
        })
      ).json().memoryStores,
    ).toEqual({ available: false });
    expect(
      (await unavailable.inject({ ...routes[0], cookies })).statusCode,
    ).toBe(404);
  });
  it("rejects non-object bodies and coerced boolean values", async () => {
    const { app, cookies } = setup();
    for (const payload of ["null", "[]", '"text"']) {
      const response = await app.inject({
        ...routes[2],
        cookies,
        payload,
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(
      (
        await app.inject({
          ...routes[4],
          cookies,
          payload: { path: "/memories/a.md", protected: "true" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ ...routes[7], cookies, payload: { autoDream: 1 } }))
        .statusCode,
    ).toBe(400);
  });
  it("sanitizes persisted run errors", async () => {
    const { app, memory, cookies } = setup();
    const internal = state();
    internal.run!.error = "private-store private-source";
    memory.status.mockResolvedValueOnce(internal);
    const response = await app.inject({ ...routes[1], cookies });
    expect(response.statusCode).toBe(200);
    expect(response.json().run.error).toBeTruthy();
    expect(response.body).not.toContain("private");
  });
});
