import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";
import { HttpError, language } from "../../http/errors.ts";
import { accountProfileSchema } from "./account-profile.ts";
import type { AuthConfiguration, Authentication } from "./auth.ts";

const paths = {
  GET: [
    "/verify-email",
    "/reset-password/{token}",
    "/get-session",
    "/list-sessions",
    "/open-api/generate-schema",
  ],
  POST: [
    "/sign-up/email",
    "/sign-in/email",
    "/sign-out",
    "/send-verification-email",
    "/request-password-reset",
    "/reset-password",
    "/change-password",
    "/update-user",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
    "/two-factor/enable",
    "/two-factor/disable",
    "/two-factor/verify-totp",
    "/two-factor/verify-backup-code",
    "/two-factor/generate-backup-codes",
    "/two-factor/get-totp-uri",
  ],
} as const;

export async function authenticationSchema(auth: Authentication) {
  const schema = await auth.schema();
  const publicPaths = new Set([
    "/verify-email",
    "/reset-password/{token}",
    "/sign-up/email",
    "/sign-in/email",
    "/send-verification-email",
    "/request-password-reset",
    "/reset-password",
    "/open-api/generate-schema",
  ]);
  const errorSchema = {
    type: "object",
    required: ["error", "requestId"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
      },
      requestId: { type: "string" },
    },
  };
  const exposed = Object.fromEntries(
    Object.entries(schema.paths).flatMap(([path, operations]) => {
      const filtered = Object.fromEntries(
        Object.entries(operations).flatMap(([method, operation]) => {
          const allowed =
            method === "get" ? paths.GET : method === "post" ? paths.POST : [];
          if (!(allowed as readonly string[]).includes(path)) return [];
          const challenge = [
            "/two-factor/verify-totp",
            "/two-factor/verify-backup-code",
          ].includes(path);
          return [
            [
              method,
              {
                ...operation,
                ...(path === "/update-user"
                  ? {
                      requestBody: {
                        required: true,
                        content: {
                          "application/json": { schema: accountProfileSchema },
                        },
                      },
                    }
                  : {}),
                security: publicPaths.has(path)
                  ? []
                  : challenge
                    ? [{ quendaSession: [] }, { quendaChallenge: [] }]
                    : [{ quendaSession: [] }],
                responses: {
                  ...operation.responses,
                  ...(path === "/update-user"
                    ? {
                        "200": {
                          description: "Nombre actualizado",
                          content: {
                            "application/json": {
                              schema: {
                                type: "object",
                                required: ["status"],
                                properties: { status: { type: "boolean" } },
                              },
                            },
                          },
                        },
                      }
                    : {}),
                  ...Object.fromEntries(
                    [400, 401, 403, 404, 409, 413, 415, 429, 500].map(
                      (status) => [
                        String(status),
                        {
                          description: "Solicitud rechazada",
                          content: {
                            "application/json": { schema: errorSchema },
                          },
                        },
                      ],
                    ),
                  ),
                },
              },
            ],
          ];
        }),
      );
      return Object.keys(filtered).length ? [[path, filtered]] : [];
    }),
  );
  return {
    ...schema,
    paths: exposed,
    security: [],
    components: {
      ...schema.components,
      securitySchemes: {
        quendaSession: {
          type: "apiKey",
          in: "cookie",
          name: "__Secure-quenda.session_token",
        },
        quendaChallenge: {
          type: "apiKey",
          in: "cookie",
          name: "__Secure-quenda.two_factor",
        },
      },
    },
  };
}

const errorMessages: Record<string, [string, string]> = {
  INVALID_EMAIL_OR_PASSWORD: [
    "Correo o contraseña incorrectos.",
    "Correo ou contrasinal incorrectos.",
  ],
  EMAIL_NOT_VERIFIED: [
    "Verifica tu correo antes de iniciar sesión.",
    "Verifica o teu correo antes de iniciar sesión.",
  ],
  INVALID_TOKEN: [
    "El enlace no es válido o ha caducado.",
    "A ligazón non é válida ou caducou.",
  ],
  INVALID_CODE: ["El código no es válido.", "O código non é válido."],
  INVALID_BACKUP_CODE: [
    "El código de recuperación no es válido.",
    "O código de recuperación non é válido.",
  ],
  INVALID_ORIGIN: [
    "El origen de la solicitud no está permitido.",
    "A orixe da solicitude non está permitida.",
  ],
  RATE_LIMITED: [
    "Demasiados intentos. Espera antes de repetir.",
    "Demasiados intentos. Agarda antes de repetir.",
  ],
};

export async function registerAuthentication(
  app: FastifyInstance,
  auth: Authentication,
  config: AuthConfiguration,
) {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    schema: { hide: true },
    async handler(request, reply) {
      const url = new URL(request.url, config.origin);
      const path = url.pathname.slice("/api/auth".length);
      const allowed: readonly string[] =
        request.method === "GET" ? paths.GET : paths.POST;
      if (
        !allowed.includes(path) &&
        !(request.method === "GET" && /^\/reset-password\/[^/]+$/.test(path))
      )
        throw new HttpError("NOT_FOUND");
      if (path === "/open-api/generate-schema")
        return authenticationSchema(auth);
      const headers = fromNodeHeaders(request.headers);
      for (const name of [
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-real-ip",
        "cf-connecting-ip",
      ])
        headers.delete(name);
      headers.set("host", new URL(config.origin).host);
      // Only Fastify's resolved peer is authoritative; client-supplied headers
      // never become rate-limit identities or proxy configuration.
      headers.set("x-quenda-client-ip", request.ip);
      const response = await auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          ...(request.method === "POST"
            ? { body: JSON.stringify(request.body ?? {}) }
            : {}),
        }),
      );
      response.headers.forEach((value, name) => {
        if (name !== "set-cookie" && name !== "content-length")
          reply.header(name, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      reply.code(response.status);
      const text = await response.text();
      if (response.status >= 400) {
        if (response.status >= 500) throw new HttpError("INTERNAL_ERROR");
        let code = response.status === 429 ? "RATE_LIMITED" : "AUTH_REJECTED";
        try {
          const data = JSON.parse(text);
          if (typeof data.code === "string") code = data.code;
        } catch {
          /* Keep a safe fallback. */
        }
        const locale = language(request.headers["accept-language"]);
        const message = (errorMessages[code] ?? [
          "Solicitud de autenticación rechazada.",
          "Solicitude de autenticación rexeitada.",
        ])[locale === "gl" ? 1 : 0];
        return reply
          .header("content-language", locale)
          .send({ error: { code, message }, requestId: request.id });
      }
      return reply.send(text || null);
    },
  });
  app.get(
    "/api/me",
    {
      schema: {
        operationId: "currentAccount",
        tags: ["Identity"],
        security: [{ quendaSession: [] }],
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["accountId", "email", "mfaVerified"],
            properties: {
              accountId: { type: "string" },
              email: { type: "string", format: "email" },
              mfaVerified: { type: "boolean" },
            },
          },
          401: { $ref: "ErrorResponse#" },
        },
      },
    },
    async (request) => {
      const account = await auth.authenticate(fromNodeHeaders(request.headers));
      if (!account) throw new HttpError("UNAUTHENTICATED");
      return {
        accountId: account.accountId,
        email: account.email,
        mfaVerified: account.mfaVerifiedAt !== null,
      };
    },
  );
}
