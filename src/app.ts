import { randomUUID } from "node:crypto";
import swagger from "@fastify/swagger";
import Fastify, { LogController } from "fastify";
import type { Pool } from "pg";
import { type Config, defaultIdempotencyRetentionSeconds } from "./config.ts";
import type { DatabaseHealth } from "./database/pools.ts";
import { HttpError, registerErrors } from "./http/errors.ts";
import { registerSourceOffer, type SourceOffer } from "./http/source-offer.ts";
import { registerCatalog } from "./modules/catalog/index.ts";
import { registerCollaboration } from "./modules/collaboration/index.ts";
import { registerCommunications } from "./modules/communications/index.ts";
import type {
  AuthConfiguration,
  Authentication,
} from "./modules/identity/index.ts";
import {
  accessFailureAudit,
  registerAuthentication,
  registerMunicipalIdentity,
} from "./modules/identity/index.ts";

import { registerReservations } from "./modules/reservations/index.ts";

const healthSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", enum: ["ok"] } },
} as const;

export async function buildApp(options: {
  database: DatabaseHealth;
  sourceOffer?: SourceOffer;
  idempotencyRetentionSeconds?: number;
  domain?: Pool;
  logLevel?: Config["logLevel"];
  identity?: { authentication: Authentication; config: AuthConfiguration };
}) {
  const app = Fastify({
    logger: { level: options.logLevel ?? "info" },
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 1048576,
    requestTimeout: 10000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.addHook("onClose", async () => {
    await options.database.close();
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        status: reply.statusCode,
        elapsedMs: reply.elapsedTime,
      },
      "Request completed",
    );
  });
  registerErrors(
    app,
    options.domain ? accessFailureAudit(options.domain) : undefined,
  );
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      components: {
        securitySchemes: {
          quendaSession: {
            type: "apiKey",
            in: "cookie",
            name: "__Secure-quenda.session_token",
          },
        },
      },
      info: {
        title: "Quenda API",
        version: "0.1.0",
        license: {
          name: "AGPL-3.0-only",
          url: "https://spdx.org/licenses/AGPL-3.0-only.html",
        },
      },
    },
  });
  registerSourceOffer(app, options.sourceOffer);
  if (options.identity) {
    await registerAuthentication(
      app,
      options.identity.authentication,
      options.identity.config,
    );
    if (options.domain) {
      await registerCommunications(
        app,
        options.domain,
        options.identity.authentication,
        options.identity.config,
      );
      await registerCollaboration(
        app,
        options.domain,
        options.identity.authentication,
        options.identity.config,
        options.idempotencyRetentionSeconds ??
          defaultIdempotencyRetentionSeconds,
      );
      await registerReservations(
        app,
        options.domain,
        options.identity.authentication,
        options.identity.config,
        options.idempotencyRetentionSeconds ??
          defaultIdempotencyRetentionSeconds,
      );
      await registerCatalog(
        app,
        options.domain,
        options.identity.authentication,
        options.identity.config,
      );
      await registerMunicipalIdentity(
        app,
        options.domain,
        options.identity.authentication,
        options.identity.config,
      );
    }
  }
  app.get(
    "/health/live",
    {
      schema: {
        operationId: "liveness",
        tags: ["Operations"],
        response: { 200: healthSchema },
      },
    },
    async () => ({ status: "ok" }),
  );
  app.get(
    "/health/ready",
    {
      schema: {
        operationId: "readiness",
        tags: ["Operations"],
        response: {
          200: healthSchema,
          503: { $ref: "ErrorResponse#" },
        },
      },
    },
    async () => {
      try {
        await options.database.check();
      } catch {
        throw new HttpError("UNAVAILABLE");
      }
      return { status: "ok" };
    },
  );
  return app;
}
