import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError, language } from "../../http/errors.ts";
import type { AuthConfiguration, Authentication } from "./auth.ts";

const failures = Object.fromEntries(
  [400, 403, 429, 500, 503].map((status) => [
    status,
    { $ref: "ErrorResponse#" },
  ]),
);

export async function registerReactivationRoutes(
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
  app.post<{ Body: { email: string; password: string } }>(
    "/api/account/reactivation/request",
    {
      schema: {
        operationId: "requestAccountReactivation",
        tags: ["Identity"],
        security: [],
        description:
          "Solicita un enlace de reactivación de una baja voluntaria. Requiere contraseña y Origin autorizado. Respuesta uniforme para direcciones desconocidas, credenciales incorrectas y cuentas no reactivables. El enlace caduca en 10 minutos; no inicia sesión.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email", maxLength: 320 },
            password: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        response: {
          ...failures,
          202: {
            type: "object",
            additionalProperties: false,
            required: ["status"],
            properties: { status: { type: "string", enum: ["REQUESTED"] } },
          },
        },
      },
    },
    async (request, reply) => {
      checkOrigin(request);
      await auth.requestReactivation(
        request.body,
        request.ip,
        language(request.headers["accept-language"]),
      );
      return reply
        .header("cache-control", "no-store")
        .code(202)
        .send({ status: "REQUESTED" });
    },
  );
  app.post<{
    Body: {
      token: string;
      password: string;
      totpCode?: string;
      backupCode?: string;
    };
  }>(
    "/api/account/reactivation/confirm",
    {
      schema: {
        operationId: "confirmAccountReactivation",
        tags: ["Identity"],
        security: [],
        description:
          "Reactiva exclusivamente una baja voluntaria mediante enlace de un solo uso, contraseña actual y TOTP o código de respaldo si MFA estaba habilitado. El código de respaldo se consume atómicamente con la reactivación. No levanta suspensiones, recupera permisos administrativos ni crea sesiones. Después debe iniciarse sesión normalmente. Las cuentas suprimidas requieren un nuevo registro.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["token", "password"],
          not: { required: ["totpCode", "backupCode"] },
          properties: {
            token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
            password: { type: "string", minLength: 1, maxLength: 128 },
            totpCode: { type: "string", pattern: "^[0-9]{6}$" },
            backupCode: {
              type: "string",
              pattern: "^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$",
            },
          },
        },
        response: {
          ...failures,
          409: { $ref: "ErrorResponse#" },
          200: {
            type: "object",
            additionalProperties: false,
            required: ["status", "reactivatedAt"],
            properties: {
              status: { type: "string", enum: ["REACTIVATED"] },
              reactivatedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      checkOrigin(request);
      const result = await auth.confirmReactivation(
        request.body,
        request.ip,
        request.id,
      );
      return reply.header("cache-control", "no-store").send(result);
    },
  );
}
