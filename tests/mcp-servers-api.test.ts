import { describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, buildApp } from "../apps/api/src/app.js";
import {
  McpServerNameConflictError,
  McpUrlUnsafeError,
} from "../packages/domain/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";
const server = {
  id: "00000000-0000-4000-8000-000000000010",
  name: "Feishu",
  url: "https://mcp.example.com/mcp",
  status: "active" as const,
  createdAt: new Date("2026-10-17T00:00:00.000Z"),
  updatedAt: new Date("2026-10-17T00:00:00.000Z"),
};

function auth() {
  return {
    login: vi.fn(),
    authenticate: vi.fn(async () => ({
      userId,
      sessionId: "session-1",
      authSubject: "subject-user",
      email: "user@example.com",
      role: "user" as const,
    })),
    renew: vi.fn(async () => ({
      expiresAt: new Date("2026-09-07T00:00:00.000Z"),
    })),
    logout: vi.fn(),
  };
}

function mcp() {
  return {
    list: vi.fn(async () => [server]),
    create: vi.fn(async () => server),
    setEnabled: vi.fn(async () => ({ ...server, status: "disabled" as const })),
    delete: vi.fn(async () => undefined),
  };
}

describe("MCP server API", () => {
  it("lists, creates, disables, and deletes servers", async () => {
    const service = mcp();
    const app = buildApp({ auth: auth(), mcpServers: service });
    const cookies = { [AUTH_COOKIE_NAME]: "token" };

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/mcp-servers",
      cookies,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().servers[0]).toMatchObject({
      name: "Feishu",
      enabled: true,
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mcp-servers",
      cookies,
      payload: { name: "Feishu", url: "https://mcp.example.com/mcp" },
    });
    expect(created.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith(userId, {
      name: "Feishu",
      url: "https://mcp.example.com/mcp",
    });

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/v1/mcp-servers/${server.id}`,
      cookies,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().server.enabled).toBe(false);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/mcp-servers/${server.id}`,
      cookies,
    });
    expect(deleted.statusCode).toBe(204);
    await app.close();
  });

  it("maps unsafe URLs and duplicate names to stable errors", async () => {
    const unsafe = mcp();
    unsafe.create.mockRejectedValueOnce(new McpUrlUnsafeError("private host"));
    const unsafeApp = buildApp({ auth: auth(), mcpServers: unsafe });
    const unsafeResponse = await unsafeApp.inject({
      method: "POST",
      url: "/api/v1/mcp-servers",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      payload: { name: "Bad", url: "https://127.0.0.1/mcp" },
    });
    expect(unsafeResponse.statusCode).toBe(400);
    expect(unsafeResponse.json()).toMatchObject({
      error: { code: "MCP_URL_UNSAFE" },
    });
    await unsafeApp.close();

    const conflict = mcp();
    conflict.create.mockRejectedValueOnce(new McpServerNameConflictError());
    const conflictApp = buildApp({ auth: auth(), mcpServers: conflict });
    const conflictResponse = await conflictApp.inject({
      method: "POST",
      url: "/api/v1/mcp-servers",
      cookies: { [AUTH_COOKIE_NAME]: "token" },
      payload: { name: "Feishu", url: "https://mcp.example.com/mcp" },
    });
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json()).toMatchObject({
      error: { code: "MCP_NAME_CONFLICT" },
    });
    await conflictApp.close();
  });
});
