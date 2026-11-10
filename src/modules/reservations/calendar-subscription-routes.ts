import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { HttpError, language } from "../../http/errors.ts";
import {
  consumePublicAttempt,
  publicSubjectHash,
} from "../../http/public-rate-limit.ts";
import {
  type AuthConfiguration,
  type Authentication,
  createRequestActor,
} from "../identity/index.ts";
import {
  calendarSubscriptionStatus,
  replaceCalendarSubscription,
  revokeCalendarSubscription,
  subscribedCalendar,
} from "./calendar-subscription.ts";

export async function registerCalendarSubscriptionRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const actor = createRequestActor(pool, auth, config);
  const errors = (statuses: number[]) =>
    Object.fromEntries(
      statuses.map((status) => [status, { $ref: "ErrorResponse#" }]),
    );
  const instant = { type: "string", format: "date-time" } as const;
  const status = {
    type: "object",
    additionalProperties: false,
    required: ["active", "createdAt"],
    properties: {
      active: { type: "boolean" },
      createdAt: { ...instant, nullable: true },
    },
  } as const;
  const lang = { type: "string", enum: ["es", "gl"] } as const;

  app.get(
    "/api/me/calendar-subscription",
    {
      schema: {
        operationId: "readCalendarSubscription",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description:
          "Indica si la cuenta tiene una suscripción de calendario y desde cuándo. Nunca devuelve la URL: solo se muestra al crearla o regenerarla.",
        response: { ...errors([401, 403, 429, 500, 503]), 200: status },
      },
    },
    async (request, reply) =>
      calendarSubscriptionStatus(pool, await actor(request, reply)),
  );

  app.post<{ Body: { lang?: "es" | "gl" } }>(
    "/api/me/calendar-subscription",
    {
      schema: {
        operationId: "replaceCalendarSubscription",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description:
          "Crea la suscripción de calendario de la cuenta o sustituye su secreto; la URL anterior deja de funcionar. Devuelve la URL una sola vez, también como webcal://. Quien tenga la URL ve las próximas reservas confirmadas de la cuenta sin iniciar sesión. Requiere Origin autorizado.",
        body: {
          type: "object",
          additionalProperties: false,
          properties: { lang },
        },
        response: {
          ...errors([400, 401, 403, 429, 500, 503]),
          200: {
            type: "object",
            additionalProperties: false,
            required: ["url", "webcalUrl", "createdAt"],
            properties: {
              url: { type: "string" },
              webcalUrl: { type: "string" },
              createdAt: instant,
            },
          },
        },
      },
    },
    async (request, reply) =>
      replaceCalendarSubscription(
        pool,
        await actor(request, reply),
        config.origin,
        request.body?.lang ?? language(request.headers["accept-language"]),
      ),
  );

  app.post(
    "/api/me/calendar-subscription/revoke",
    {
      schema: {
        operationId: "revokeCalendarSubscription",
        tags: ["Reservations"],
        security: [{ quendaSession: [] }],
        description:
          "Retira la suscripción de calendario: la URL deja de funcionar de inmediato. revoked es false si no había ninguna. Requiere Origin autorizado.",
        response: {
          ...errors([401, 403, 429, 500, 503]),
          200: {
            type: "object",
            additionalProperties: false,
            required: ["revoked"],
            properties: { revoked: { type: "boolean" } },
          },
        },
      },
    },
    async (request, reply) =>
      revokeCalendarSubscription(pool, await actor(request, reply)),
  );

  // Calendar applications poll from shared addresses, so the limit follows the
  // secret. Unknown secrets also count against the address, which slows guessing.
  const limited = async (reply: FastifyReply, subject: string) => {
    const decision = await consumePublicAttempt(pool, subject);
    if (!decision.allowed) {
      reply.header("retry-after", decision.retryAfter);
      throw new HttpError("RATE_LIMITED");
    }
  };
  app.get<{ Params: { file: string }; Querystring: { lang?: "es" | "gl" } }>(
    "/api/calendars/:file",
    {
      schema: {
        operationId: "subscribedCalendar",
        tags: ["Reservations"],
        security: [],
        description:
          "Calendario iCalendar (RFC 5545) de una suscripción: próximas reservas confirmadas de la cuenta, hasta 100, en UTC y con la misma identidad y revisión que las descargas. Una reserva cancelada o finalizada desaparece del calendario. No usa sesión: la URL es el secreto. Una URL desconocida, retirada o de una cuenta inactiva responde 404. Límite de 60 peticiones por minuto y URL.",
        params: {
          type: "object",
          additionalProperties: false,
          required: ["file"],
          properties: {
            file: { type: "string", pattern: "^[A-Za-z0-9_-]{43}\\.ics$" },
          },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { lang },
        },
        response: {
          ...errors([400, 404, 429, 500, 503]),
          200: {
            description: "Calendario de la suscripción",
            content: { "text/calendar": { schema: { type: "string" } } },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { file: string };
        Querystring: { lang?: "es" | "gl" };
      }>,
      reply,
    ) => {
      const token = request.params.file.slice(0, -".ics".length);
      await limited(
        reply,
        createHmac("sha256", config.secret)
          .update("quenda:calendar-subscription\0")
          .update(token)
          .digest("hex"),
      );
      try {
        const body = await subscribedCalendar(
          pool,
          token,
          config.origin,
          request.query.lang ?? language(request.headers["accept-language"]),
        );
        return reply
          .header("content-type", "text/calendar; charset=utf-8")
          .header("cache-control", "private, no-store")
          .send(body);
      } catch (error) {
        if (error instanceof HttpError && error.code === "NOT_FOUND")
          await limited(reply, publicSubjectHash(config.secret, request.ip));
        throw error;
      }
    },
  );
}
