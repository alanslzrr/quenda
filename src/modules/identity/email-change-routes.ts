import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError, language } from "../../http/errors.ts";
import type { AuthConfiguration, Authentication } from "./auth.ts";

const failures = Object.fromEntries(
  [400, 401, 403, 409, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);
const token = { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" };
const password = { type: "string", minLength: 1, maxLength: 128 };
const response = (status: string) => ({
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", enum: [status] } },
});

export async function registerEmailChangeRoutes(
  app: FastifyInstance,
  auth: Authentication,
  config: AuthConfiguration,
) {
  const checkOrigin = (request: FastifyRequest) => {
    if (
      request.headers.origin !== config.origin ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      throw new HttpError("FORBIDDEN");
  };
  app.post<{ Body: { newEmail: string; password: string } }>(
    "/api/me/email-change/request",
    {
      schema: {
        operationId: "requestEmailChange",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Solicita cambiar el correo global con contraseña actual y MFA reciente si está habilitado. Envía autorización al correo actual. No modifica todavía la identidad ni revela si el nuevo correo pertenece a otra cuenta. La solicitud y sus dos confirmaciones caducan a los diez minutos. No admite actuaciones municipales en nombre del titular.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["newEmail", "password"],
          properties: {
            newEmail: { type: "string", format: "email", maxLength: 320 },
            password,
          },
        },
        response: { ...failures, 202: response("REQUESTED") },
      },
    },
    async (request, reply) => {
      checkOrigin(request);
      await auth.requestEmailChange(
        fromNodeHeaders(request.headers),
        request.body,
        language(request.headers["accept-language"]),
      );
      return reply
        .header("cache-control", "no-store")
        .code(202)
        .send({ status: "REQUESTED" });
    },
  );
  app.post<{ Body: { token: string } }>(
    "/api/me/email-change/approve",
    {
      schema: {
        operationId: "approveEmailChange",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Consume la autorización recibida en el correo actual y envía una verificación al nuevo. Requiere la sesión que inició la solicitud. El correo global no cambia. Los enlaces no ejecutan acciones por GET.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["token"],
          properties: { token },
        },
        response: { ...failures, 202: response("VERIFICATION_SENT") },
      },
    },
    async (request, reply) => {
      checkOrigin(request);
      await auth.approveEmailChange(
        fromNodeHeaders(request.headers),
        request.body,
        language(request.headers["accept-language"]),
      );
      return reply
        .header("cache-control", "no-store")
        .code(202)
        .send({ status: "VERIFICATION_SENT" });
    },
  );
  app.post<{ Body: { token: string; password?: string } }>(
    "/api/me/email-change/confirm",
    {
      schema: {
        operationId: "confirmEmailChange",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        description:
          "Verifica el correo nuevo y cambia atómicamente la identidad global. Exige la sesión original en autoservicio. La recuperación asistida exige sesión del titular, contraseña actual y MFA reciente si corresponde, además de la verificación operativa previa. Revoca todas las sesiones y enlaces pendientes de recuperación; debe iniciarse sesión con el nuevo correo. Nunca reactiva cuentas ni modifica permisos municipales.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["token"],
          properties: { token, password },
        },
        response: {
          ...failures,
          200: {
            type: "object",
            additionalProperties: false,
            required: ["status", "changedAt"],
            properties: {
              status: { type: "string", enum: ["EMAIL_CHANGED"] },
              changedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      checkOrigin(request);
      const result = await auth.confirmEmailChange(
        fromNodeHeaders(request.headers),
        request.body,
        request.id,
      );
      return reply.header("cache-control", "no-store").send(result);
    },
  );
}
