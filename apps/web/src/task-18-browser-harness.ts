const platformAgentId = "00000000-0000-4000-8000-000000000101";
const createdPlatformAgentId = "00000000-0000-4000-8000-000000000102";
const userId = "00000000-0000-4000-8000-000000000201";
const adminId = "00000000-0000-4000-8000-000000000202";
const uploadId = "00000000-0000-4000-8000-000000000301";
const sessionId = "00000000-0000-4000-8000-000000000401";
const personalAgentId = "00000000-0000-4000-8000-000000000501";
const artifactId = "00000000-0000-4000-8000-000000000601";

interface BrowserCall {
  method: string;
  path: string;
  body: unknown;
}

interface PlatformAgent {
  id: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  arkVersion: string;
  status: "active" | "disabled";
  lastErrorCode: null;
}

interface UserAgent {
  id: string;
  name: string;
  description: string;
  modelId: string;
  systemPrompt: string;
  version: string;
  status: "active";
  kind: "platform" | "personal";
  editable: boolean;
  isAutoDefault: boolean;
  skills: Array<{ id: string; displayTitle: string }>;
}

interface BrowserSession {
  id: string;
  title: string;
  status: "idle" | "running";
  error: null;
  deletionState: "none" | "pending";
  archivedAt: string | null;
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
  agent: {
    id: string;
    kind: "platform";
    name: string;
    version: string;
  };
  inputs: Array<{
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    mountPath: string;
  }>;
}

interface Quota {
  personalAgentLimit: number;
  concurrentSessionLimit: number;
  dailySessionLimit: number;
  monthlyTokenLimit: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function apiError(code: string, status: number, retryable = false): Response {
  return json(
    {
      error: {
        code,
        message: "Request failed",
        requestId: "task-18-request",
        retryable,
      },
    },
    status,
  );
}

function parseBody(init?: RequestInit): Record<string, unknown> {
  return typeof init?.body === "string"
    ? (JSON.parse(init.body) as Record<string, unknown>)
    : {};
}

export class AcceptanceEventSource {
  static instances: AcceptanceEventSource[] = [];

  readonly listeners = new Map<string, Set<EventListener>>();
  readonly url: string;
  readonly withCredentials: boolean;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL, options?: EventSourceInit) {
    this.url = String(url);
    this.withCredentials = options?.withCredentials ?? false;
    AcceptanceEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    const callback =
      typeof listener === "function"
        ? listener
        : (event: Event) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (typeof listener === "function") {
      this.listeners.get(type)?.delete(listener);
    }
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.(new Event("open"));
  }

  emitError(): void {
    this.onerror?.(new Event("error"));
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export function createTask18BrowserBackend() {
  let identity:
    { userId: string; authSubject: string; role: "user" | "admin" } | undefined;
  let session: BrowserSession | undefined;
  let quota: Quota = {
    personalAgentLimit: 10,
    concurrentSessionLimit: 2,
    dailySessionLimit: 25,
    monthlyTokenLimit: 1000,
  };
  let quotaOverrides: Record<keyof Quota, number | null> = {
    personalAgentLimit: 10,
    concurrentSessionLimit: 2,
    dailySessionLimit: 25,
    monthlyTokenLimit: 1000,
  };
  const calls: BrowserCall[] = [];
  const platformAgents: PlatformAgent[] = [
    {
      id: platformAgentId,
      name: "Research assistant",
      description: "Default assigned Agent",
      modelId: "model-a",
      systemPrompt: "Use primary sources.",
      arkVersion: "1",
      status: "active",
      lastErrorCode: null,
    },
  ];
  const userAgents: UserAgent[] = [
    {
      id: platformAgentId,
      name: "Research assistant",
      description: "Default assigned Agent",
      modelId: "model-a",
      systemPrompt: "",
      version: "1",
      status: "active",
      kind: "platform",
      editable: false,
      isAutoDefault: false,
      skills: [],
    },
  ];
  const adminUsers: Array<{
    id: string;
    email: string;
    role: "user" | "admin";
    status: "active";
    hasPassword: boolean;
    defaultAgentId: string | null;
    createdAt: string;
    updatedAt: string;
    quota: Quota;
  }> = [
    {
      id: userId,
      email: "user-a@example.com",
      role: "user",
      status: "active",
      hasPassword: true,
      defaultAgentId: platformAgentId as string | null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      quota,
    },
  ];
  const adminUser = adminUsers[0]!;

  async function fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = parseBody(init);
    calls.push({ method, path, body });

    if (path === "/api/v1/auth/login" && method === "POST") {
      if (body.password === "wrong-password") {
        return apiError("AUTH_REQUIRED", 401);
      }
      const email = String(body.email);
      identity =
        email === "admin@example.com"
          ? {
              userId: adminId,
              authSubject: `local:${email}`,
              role: "admin",
            }
          : {
              userId,
              authSubject: `local:${email}`,
              role: "user",
            };
      return noContent();
    }
    if (path === "/api/v1/me") {
      return identity
        ? json({ user: identity })
        : apiError("AUTH_REQUIRED", 401);
    }
    if (!identity) return apiError("AUTH_REQUIRED", 401);

    if (path === "/api/v1/admin/platform-agents" && method === "GET") {
      return json({ agents: platformAgents });
    }
    if (path === "/api/v1/admin/platform-agents" && method === "POST") {
      const created: PlatformAgent = {
        id: createdPlatformAgentId,
        name: String(body.name),
        description: String(body.description),
        modelId: String(body.modelId),
        systemPrompt: String(body.systemPrompt),
        arkVersion: "1",
        status: "active",
        lastErrorCode: null,
      };
      platformAgents.push(created);
      return json(created, 201);
    }
    if (
      path.startsWith("/api/v1/admin/platform-agents/") &&
      method === "PATCH"
    ) {
      const id = path.split("/").at(-1);
      const agent = platformAgents.find((candidate) => candidate.id === id);
      if (!agent) return apiError("RESOURCE_NOT_FOUND", 404);
      if (body.status === "active" || body.status === "disabled") {
        agent.status = body.status;
      } else {
        agent.name = String(body.name);
        agent.description = String(body.description);
        agent.modelId = String(body.modelId);
        agent.systemPrompt = String(body.systemPrompt);
        agent.arkVersion = String(Number(agent.arkVersion) + 1);
      }
      return json(agent);
    }
    if (
      path.startsWith("/api/v1/admin/platform-agents/") &&
      method === "DELETE"
    ) {
      const id = path.split("/").at(-1);
      if (adminUser.defaultAgentId === id) {
        return apiError("AGENT_REFERENCED", 409);
      }
      const index = platformAgents.findIndex((agent) => agent.id === id);
      if (index < 0) return apiError("RESOURCE_NOT_FOUND", 404);
      platformAgents.splice(index, 1);
      return noContent();
    }
    if (path === "/api/v1/admin/users" && method === "GET") {
      return json({ users: adminUsers.map((entry) => ({ ...entry, quota })) });
    }
    if (/^\/api\/v1\/admin\/users\/[^/]+$/.test(path) && method === "GET") {
      const target = adminUsers.find(
        (entry) => entry.id === path.split("/").at(-1),
      );
      if (!target) return apiError("RESOURCE_NOT_FOUND", 404);
      const overrides = quotaOverrides;
      return json({
        ...target,
        quota,
        inherited: {
          personalAgentLimit: !overrides.personalAgentLimit,
          concurrentSessionLimit: !overrides.concurrentSessionLimit,
          dailySessionLimit: !overrides.dailySessionLimit,
          monthlyTokenLimit: !overrides.monthlyTokenLimit,
        },
        usage: {
          personalAgents: 0,
          concurrentSessions: 0,
          dailySessions: 0,
          inputTokens: 0,
          outputTokens: 0,
          tokens: 0,
          runtimeMs: 0,
          toolCalls: 0,
        },
        exhausted: {
          personalAgents: false,
          concurrentSessions: false,
          dailySessions: false,
          monthlyTokens: false,
        },
        period: {
          startsAt: "2026-09-01T00:00:00.000Z",
          endsAt: "2026-10-01T00:00:00.000Z",
        },
      });
    }
    if (path === "/api/v1/admin/users" && method === "POST") {
      const email = String(body.email).trim().toLowerCase();
      if (adminUsers.some((entry) => entry.email === email)) {
        return apiError("USER_EMAIL_CONFLICT", 409);
      }
      const created = {
        id: `00000000-0000-4000-8000-0000000009${adminUsers.length}`,
        email,
        role: (body.role === "admin" ? "admin" : "user") as "user" | "admin",
        status: "active" as const,
        hasPassword: true,
        defaultAgentId: null,
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
        quota,
      };
      adminUsers.push(created);
      return json(
        {
          id: created.id,
          email: created.email,
          role: created.role,
          status: created.status,
        },
        201,
      );
    }
    if (path.endsWith("/password") && method === "POST") {
      const id = path.split("/").at(-2);
      const target = adminUsers.find((entry) => entry.id === id);
      if (!target) return apiError("RESOURCE_NOT_FOUND", 404);
      target.hasPassword = true;
      return noContent();
    }
    if (path.endsWith("/default-agent") && method === "PUT") {
      adminUser.defaultAgentId = String(body.platformAgentId);
      return json({
        userId,
        platformAgentId: adminUser.defaultAgentId,
        assignedAt: "2026-09-07T08:00:00.000Z",
      });
    }
    if (path.endsWith("/quota") && method === "PUT") {
      // Sparse override semantics: null / omitted dimensions inherit.
      const values = body as Partial<Record<keyof Quota, number | null>>;
      quota = {
        personalAgentLimit:
          values.personalAgentLimit ?? quota.personalAgentLimit,
        concurrentSessionLimit:
          values.concurrentSessionLimit ?? quota.concurrentSessionLimit,
        dailySessionLimit: values.dailySessionLimit ?? quota.dailySessionLimit,
        monthlyTokenLimit: values.monthlyTokenLimit ?? quota.monthlyTokenLimit,
      };
      quotaOverrides = {
        personalAgentLimit: values.personalAgentLimit ?? null,
        concurrentSessionLimit: values.concurrentSessionLimit ?? null,
        dailySessionLimit: values.dailySessionLimit ?? null,
        monthlyTokenLimit: values.monthlyTokenLimit ?? null,
      };
      adminUser.quota = quota;
      return json({ userId, ...quota, inherited: quotaOverrides });
    }

    if (path === "/api/v1/agents" && method === "GET") {
      return json({
        agents: userAgents,
        selection: { agentId: platformAgentId, source: "default" },
        blocker: null,
      });
    }
    if (path === "/api/v1/agents" && method === "POST") {
      const created: UserAgent = {
        id: personalAgentId,
        name: String(body.name),
        description: String(body.description),
        modelId: String(body.modelId),
        systemPrompt: String(body.systemPrompt),
        version: "1",
        status: "active",
        kind: "personal",
        editable: true,
        isAutoDefault: false,
        skills: [],
      };
      userAgents.push(created);
      return json(created, 201);
    }
    if (path === `/api/v1/agents/${personalAgentId}` && method === "GET") {
      return json(userAgents.find((agent) => agent.id === personalAgentId));
    }
    if (path === `/api/v1/agents/${personalAgentId}` && method === "PATCH") {
      const agent = userAgents.find(
        (candidate) => candidate.id === personalAgentId,
      )!;
      agent.name = String(body.name);
      agent.description = String(body.description);
      agent.modelId = String(body.modelId);
      agent.systemPrompt = String(body.systemPrompt);
      agent.version = String(Number(agent.version) + 1);
      return json(agent);
    }
    if (path === `/api/v1/agents/${personalAgentId}` && method === "DELETE") {
      userAgents.splice(
        userAgents.findIndex((agent) => agent.id === personalAgentId),
        1,
      );
      return noContent();
    }
    if (path === "/api/v1/capabilities") {
      return json({
        skills: { available: true },
        mcpServers: { available: false },
        vaults: { available: false },
        memoryStores: { available: false },
        personalAgentModels: ["model-a"],
      });
    }
    if (path === "/api/v1/skills" && method === "GET") {
      return json({ skills: [], scope: "custom" });
    }
    if (path === "/api/v1/usage") {
      return json({
        period: {
          startsAt: "2026-09-01T00:00:00.000Z",
          endsAt: "2026-10-01T00:00:00.000Z",
        },
        quota,
        usage: {
          personalAgents: 0,
          concurrentSessions: 0,
          dailySessions: 0,
          inputTokens: 0,
          outputTokens: 0,
          tokens: 0,
          runtimeMs: 0,
          toolCalls: 0,
        },
        exhausted: {
          personalAgents: false,
          concurrentSessions: false,
          dailySessions: false,
          monthlyTokens: false,
        },
      });
    }
    if (path === "/api/v1/uploads" && method === "POST") {
      return json(
        {
          id: uploadId,
          name: "brief.txt",
          mimeType: "text/plain",
          sizeBytes: 16,
          mountPath: `/mnt/session/inputs/${uploadId}-brief.txt`,
          status: "uploaded",
          expiresAt: "2026-09-08T00:00:00.000Z",
        },
        201,
      );
    }
    if (path === "/api/v1/sessions" && method === "POST") {
      session = {
        id: sessionId,
        title: String(body.title),
        status: "idle",
        error: null,
        deletionState: "none",
        archivedAt: null,
        lastEventAt: null,
        createdAt: "2026-09-07T08:00:00.000Z",
        updatedAt: "2026-09-07T08:00:00.000Z",
        agent: {
          id: platformAgentId,
          kind: "platform",
          name: "Research assistant",
          version: "1",
        },
        inputs: [
          {
            id: uploadId,
            name: "brief.txt",
            mimeType: "text/plain",
            sizeBytes: 16,
            mountPath: `/mnt/session/inputs/${uploadId}-brief.txt`,
          },
        ],
      };
      return json(session, 201);
    }
    if (path === "/api/v1/sessions" && method === "GET") {
      const archived = url.searchParams.get("archived") === "true";
      return json({
        sessions:
          session &&
          session.deletionState !== "pending" &&
          Boolean(session.archivedAt) === archived
            ? [session]
            : [],
      });
    }
    if (path === `/api/v1/sessions/${sessionId}` && method === "GET") {
      return session ? json(session) : apiError("RESOURCE_NOT_FOUND", 404);
    }
    if (path.endsWith("/messages") && method === "POST") {
      if (session) session.status = "running";
      return json(
        { eventId: `message-${calls.length}`, delivery: "queued" },
        202,
      );
    }
    if (path.endsWith("/interrupt") && method === "POST") {
      return json({ eventId: "interrupt-1", delivery: "accepted" }, 202);
    }
    if (path.endsWith("/archive") && method === "POST" && session) {
      session.archivedAt = "2026-09-07T09:00:00.000Z";
      return json(session);
    }
    if (path.endsWith("/archive") && method === "DELETE" && session) {
      session.archivedAt = null;
      return json(session);
    }
    if (path === `/api/v1/sessions/${sessionId}` && method === "DELETE") {
      if (session) session.deletionState = "pending";
      return json({ id: sessionId, deletionState: "pending" }, 202);
    }
    if (path === "/api/v1/artifacts" && method === "GET") {
      return json({
        artifacts: session
          ? [
              {
                id: artifactId,
                sessionId,
                name: "acceptance-report.txt",
                mimeType: "text/plain",
                sizeBytes: 19,
                generatedAt: "2026-09-07T08:05:00.000Z",
                deletionState: "none",
                error: null,
              },
            ]
          : [],
      });
    }
    if (
      path === `/api/v1/artifacts/${artifactId}/download` &&
      method === "GET"
    ) {
      return new Response("acceptance artifact", {
        headers: { "content-type": "text/plain" },
      });
    }

    throw new Error(`Unexpected request: ${method} ${path}`);
  }

  return {
    fetch,
    calls,
    callsFor(method: string, suffix: string) {
      return calls.filter(
        (call) => call.method === method && call.path.endsWith(suffix),
      );
    },
    platformAgentId,
    createdPlatformAgentId,
    sessionId,
    artifactId,
    platformAgentVersion() {
      return platformAgents.find((agent) => agent.id === createdPlatformAgentId)
        ?.arkVersion;
    },
    userQuota() {
      return quota;
    },
  };
}
