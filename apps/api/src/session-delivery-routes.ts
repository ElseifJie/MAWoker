import type { FastifyInstance } from "fastify";
import { normalizeArkEvent } from "@pwa/contracts";

export interface DeliveryApiRepository {
  listTurns(
    userId: string,
    sessionId: string,
  ): PromiseLike<
    Array<{
      id: string;
      inputEventId?: string;
      boundaryEventId?: string;
      startedAt?: Date;
      outcome: string;
      summary: string;
      artifactState: string;
      artifactIds: string[];
      usageState: string;
      errorCode: string | null;
      endedAt: Date;
    }>
  >;
  requestSyncRetry(
    userId: string,
    id: string,
    now: Date,
    windowMs: number,
    sessionId?: string,
  ): PromiseLike<boolean>;
  listNotifications(
    userId: string,
    limit: number,
  ): PromiseLike<
    Array<{
      id: string;
      sessionId: string;
      turnId: string;
      kind: string;
      readAt: Date | null;
      createdAt: Date;
    }>
  >;
  markNotificationRead(userId: string, id: string): PromiseLike<boolean>;
}

const params = {
  type: "object",
  additionalProperties: false,
  properties: { id: { type: "string", format: "uuid" } },
  required: ["id"],
} as const;

export function registerSessionDeliveryRoutes(
  app: FastifyInstance,
  repository: DeliveryApiRepository,
  retryWindowMs = 300_000,
) {
  app.get<{ Params: { id: string } }>(
    "/api/v1/sessions/:id/turns",
    { schema: { params } },
    async (request) => ({
      turns: (
        await repository.listTurns(request.auth!.userId, request.params.id)
      ).map((turn) => ({
        id: turn.id,
        inputEventId: turn.inputEventId,
        boundaryEventId: turn.boundaryEventId,
        startedAt: turn.startedAt,
        outcome: turn.outcome,
        summary:
          normalizeArkEvent({
            id: turn.id,
            type: "agent.message",
            createdAt: turn.endedAt.toISOString(),
            data: { content: turn.summary },
          }).payload.content ?? "",
        artifactState: turn.artifactState,
        artifactIds: turn.artifactIds,
        usageState: turn.usageState,
        errorCode: turn.errorCode,
        endedAt: turn.endedAt,
      })),
    }),
  );
  app.post<{ Params: { id: string; turnId: string } }>(
    "/api/v1/sessions/:id/turns/:turnId/retry",
    {
      schema: {
        params: {
          ...params,
          required: ["id", "turnId"],
          properties: {
            ...params.properties,
            turnId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (request, reply) => {
      const accepted = await repository.requestSyncRetry(
        request.auth!.userId,
        request.params.turnId,
        new Date(),
        retryWindowMs,
        request.params.id,
      );
      return accepted
        ? reply.code(202).send({ status: "queued" })
        : reply.code(409).send({
            error: {
              code: "ARTIFACT_RETRY_UNAVAILABLE",
              message: "当前结果无法重新同步，请刷新任务状态后再试。",
              retryable: true,
              requestId: request.id,
            },
          });
    },
  );
  app.get("/api/v1/notifications", async (request) => ({
    notifications: (
      await repository.listNotifications(request.auth!.userId, 100)
    ).map((item) => ({
      id: item.id,
      sessionId: item.sessionId,
      turnId: item.turnId,
      kind: item.kind,
      readAt: item.readAt,
      createdAt: item.createdAt,
    })),
  }));
  app.post<{ Params: { id: string } }>(
    "/api/v1/notifications/:id/read",
    { schema: { params } },
    async (request, reply) => {
      return (await repository.markNotificationRead(
        request.auth!.userId,
        request.params.id,
      ))
        ? reply.code(204).send()
        : reply.code(404).send({
            error: {
              code: "RESOURCE_NOT_FOUND",
              message: "Resource not found",
              retryable: false,
              requestId: request.id,
            },
          });
    },
  );
}
