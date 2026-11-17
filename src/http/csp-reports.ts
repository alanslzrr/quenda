import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { publicRateLimit } from "./public-rate-limit.ts";

export const cspReportPath = "/api/csp-reports";
export const cspReportBodyLimit = 16384;

const url = { type: "string", maxLength: 2048 } as const;
const directive = {
  type: "string",
  pattern: "^[a-z][a-z-]{0,63}$",
} as const;
const disposition = { type: "string", enum: ["enforce", "report"] } as const;
const statusCode = { type: "integer", minimum: 0, maximum: 999 } as const;

// Browsers add fields over time; they are accepted here and never read.
const reportingApi = {
  type: "array",
  minItems: 1,
  maxItems: 100,
  items: {
    type: "object",
    required: ["type", "body"],
    properties: {
      type: { type: "string", enum: ["csp-violation"] },
      body: {
        type: "object",
        required: ["documentURL", "effectiveDirective"],
        properties: {
          documentURL: url,
          effectiveDirective: directive,
          blockedURL: url,
          disposition,
          statusCode,
        },
      },
    },
  },
} as const;
const legacy = {
  type: "object",
  required: ["csp-report"],
  properties: {
    "csp-report": {
      type: "object",
      required: ["document-uri"],
      anyOf: [
        { required: ["effective-directive"] },
        { required: ["violated-directive"] },
      ],
      properties: {
        "document-uri": url,
        "effective-directive": directive,
        "violated-directive": { type: "string", maxLength: 4096 },
        "blocked-uri": url,
        disposition,
        "status-code": statusCode,
      },
    },
  },
} as const;

interface Violation {
  document: string;
  directive: string | undefined;
  blocked: string | undefined;
  disposition: string | undefined;
  status: number | undefined;
}
type ReportingApiBody = {
  type: string;
  body: {
    documentURL: string;
    effectiveDirective: string;
    blockedURL?: string;
    disposition?: string;
    statusCode?: number;
  };
}[];
type LegacyBody = {
  "csp-report": {
    "document-uri": string;
    "effective-directive"?: string;
    "violated-directive"?: string;
    "blocked-uri"?: string;
    disposition?: string;
    "status-code"?: number;
  };
};

const keywords = new Set([
  "inline",
  "eval",
  "wasm-eval",
  "trusted-types-policy",
  "trusted-types-sink",
  "self",
  "data",
  "blob",
]);

/** The origin of a blocked resource, a CSP keyword or the scheme alone; never its path, query or content. */
export function blockedSource(value: string | undefined): string | null {
  if (!value) return null;
  if (keywords.has(value)) return value;
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)
      ? parsed.origin
      : parsed.protocol;
  } catch {
    return "other";
  }
}

function violations(body: unknown): Violation[] {
  if (Array.isArray(body))
    return (body as ReportingApiBody).map(({ body }) => ({
      document: body.documentURL,
      directive: body.effectiveDirective,
      blocked: body.blockedURL,
      disposition: body.disposition,
      status: body.statusCode,
    }));
  const report = (body as LegacyBody)["csp-report"];
  // Older browsers send the whole violated directive; its first token names it.
  const named = report["violated-directive"]?.trim().split(/\s+/, 1)[0];
  return [
    {
      document: report["document-uri"],
      directive:
        report["effective-directive"] ??
        (named && /^[a-z][a-z-]{0,63}$/.test(named) ? named : undefined),
      blocked: report["blocked-uri"],
      disposition: report.disposition,
      status: report["status-code"],
    },
  ];
}

/**
 * Same-origin endpoint for Content-Security-Policy violation reports. It needs no session, answers 204 without
 * echoing anything and logs one minimal event per report about a page of this instance; every other field, and
 * any report about another origin, is dropped.
 */
export async function registerCspReports(
  app: FastifyInstance,
  pool: Pool,
  config: { origin: string; secret: string },
) {
  // Reports have their own allowance, so a page that keeps violating the policy
  // does not use up the budget that public catalog reads need.
  const limit = publicRateLimit(pool, config.secret, "csp-report");
  await app.register(async (scope) => {
    // Only the two report media types; plain JSON or forms are not reports.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      ["application/reports+json", "application/csp-report"],
      { parseAs: "string" },
      scope.getDefaultJsonParser("error", "error"),
    );
    scope.post(
      cspReportPath,
      {
        bodyLimit: cspReportBodyLimit,
        onRequest: limit,
        schema: {
          operationId: "cspViolationReport",
          tags: ["Operations"],
          security: [],
          description:
            "Recibe informes de infracción de la política de seguridad de contenido enviados por el navegador. Admite la Reporting API (application/reports+json, informes csp-violation) y el formato heredado de report-uri (application/csp-report), hasta 16 KiB. No requiere sesión ni Origin y responde 204 sin cuerpo. Solo registra directiva, origen bloqueado, ruta de la página, disposición y estado HTTP; descarta el resto y los informes de páginas de otro origen. Límite propio de 60 peticiones por minuto y dirección.",
          body: {
            content: {
              "application/reports+json": { schema: reportingApi },
              "application/csp-report": { schema: legacy },
            },
          },
          response: {
            204: { type: "null", description: "Informe recibido." },
            429: { $ref: "ErrorResponse#" },
          },
        },
      },
      async (request, reply) => {
        for (const violation of violations(request.body)) {
          let document: URL;
          try {
            document = new URL(violation.document);
          } catch {
            continue;
          }
          if (document.origin !== config.origin) continue;
          request.log.warn(
            {
              event: "CSP_VIOLATION",
              directive: violation.directive ?? null,
              blocked: blockedSource(violation.blocked),
              documentPath: document.pathname,
              disposition: violation.disposition ?? null,
              status: violation.status ?? null,
            },
            "Content security policy violation",
          );
        }
        return reply.code(204).send();
      },
    );
  });
}
