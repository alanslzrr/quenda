import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";

const messages = {
  ACCOUNT_HANDOVER_REQUIRED: {
    es: "Debes transferir la última responsabilidad administrativa antes de dar de baja la cuenta.",
    gl: "Debes transferir a última responsabilidade administrativa antes de dar de baixa a conta.",
  },
  USAGE_RULES_REQUIRED: {
    es: "Añade las normas de uso para publicar esta unidad.",
    gl: "Engade as normas de uso para publicar esta unidade.",
  },
  CONDITIONS_ACCEPTANCE_REQUIRED: {
    es: "Debes revisar y aceptar las condiciones vigentes antes de confirmar. Si el plazo ya ha vencido, no podrás cancelar ni modificar la reserva por tu cuenta.",
    gl: "Debes revisar e aceptar as condicións vixentes antes de confirmar. Se o prazo xa venceu, non poderás cancelar nin modificar a reserva pola túa conta.",
  },
  CONDITIONS_CHANGED: {
    es: "Las condiciones han cambiado. Revisa y acepta las condiciones vigentes. La reserva no se ha cambiado.",
    gl: "As condicións cambiaron. Revisa e acepta as condicións vixentes. A reserva non se cambiou.",
  },
  HOLDER_ACCEPTANCE_REQUIRED: {
    es: "Solo el titular puede aceptar las normas desde su cuenta. La intervención administrativa no puede incluir una aceptación en su nombre.",
    gl: "Só o titular pode aceptar as normas desde a súa conta. A intervención administrativa non pode incluír unha aceptación no seu nome.",
  },
  RESERVATION_DEADLINE_PASSED: {
    es: "El plazo para realizar esta operación ha vencido. La reserva se mantiene; puedes contactar con el ayuntamiento.",
    gl: "O prazo para realizar esta operación venceu. A reserva mantense; podes contactar co concello.",
  },
  ACCOUNT_HAS_FUTURE_RESERVATIONS: {
    es: "No puedes dar de baja la cuenta mientras tengas reservas futuras confirmadas. Consulta tus reservas o contacta con el ayuntamiento.",
    gl: "Non podes dar de baixa a conta mentres teñas reservas futuras confirmadas. Consulta as túas reservas ou contacta co concello.",
  },
  ACCOUNT_INACTIVE: {
    es: "La cuenta está dada de baja.",
    gl: "A conta está dada de baixa.",
  },

  INVALID_INPUT: {
    es: "La solicitud contiene datos no válidos.",
    gl: "A solicitude contén datos non válidos.",
  },
  PAYLOAD_TOO_LARGE: {
    es: "La solicitud supera el tamaño permitido.",
    gl: "A solicitude supera o tamaño permitido.",
  },
  UNSUPPORTED_MEDIA_TYPE: {
    es: "El formato de la solicitud no está admitido.",
    gl: "O formato da solicitude non está admitido.",
  },
  UNAUTHENTICATED: { es: "Debes iniciar sesión.", gl: "Debes iniciar sesión." },
  RATE_LIMITED: {
    es: "Demasiadas solicitudes. Espera antes de repetir.",
    gl: "Demasiadas solicitudes. Agarda antes de repetir.",
  },
  REAUTHENTICATION_REQUIRED: {
    es: "Vuelve a verificar el segundo factor para realizar esta operación.",
    gl: "Volve verificar o segundo factor para realizar esta operación.",
  },
  FORBIDDEN: {
    es: "No tienes permiso para realizar esta operación.",
    gl: "Non tes permiso para realizar esta operación.",
  },
  NOT_FOUND: {
    es: "No se ha encontrado el recurso.",
    gl: "Non se atopou o recurso.",
  },
  CONFLICT: {
    es: "La operación entra en conflicto con el estado actual.",
    gl: "A operación entra en conflito co estado actual.",
  },
  UNAVAILABLE: {
    es: "El servicio no está disponible.",
    gl: "O servizo non está dispoñible.",
  },
  INTERNAL_ERROR: {
    es: "No se pudo completar la operación.",
    gl: "Non se puido completar a operación.",
  },
} as const;

const statuses = {
  ACCOUNT_HANDOVER_REQUIRED: 409,
  USAGE_RULES_REQUIRED: 409,
  CONDITIONS_ACCEPTANCE_REQUIRED: 409,
  CONDITIONS_CHANGED: 409,
  HOLDER_ACCEPTANCE_REQUIRED: 409,
  RESERVATION_DEADLINE_PASSED: 409,
  ACCOUNT_HAS_FUTURE_RESERVATIONS: 409,
  ACCOUNT_INACTIVE: 403,

  INVALID_INPUT: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  REAUTHENTICATION_REQUIRED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const;
export type ErrorCode = keyof typeof messages;

export class HttpError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

export function language(header: string | undefined): "es" | "gl" {
  const preferences = (header ?? "")
    .split(",")
    .map((entry) => {
      const [tag = "", ...parameters] = entry.trim().toLowerCase().split(";");
      const quality = parameters.find((p) => p.trim().startsWith("q="));
      const q = quality ? Number(quality.trim().slice(2)) : 1;
      return { tag: tag.split("-")[0], q };
    })
    .filter(({ tag, q }) => (tag === "es" || tag === "gl") && q > 0 && q <= 1)
    .sort((a, b) => b.q - a.q);
  return preferences[0]?.tag === "gl" ? "gl" : "es";
}

export const errorSchema = {
  $id: "ErrorResponse",
  examples: [
    {
      error: {
        code: "CONFLICT",
        message: "La operación entra en conflicto con el estado actual.",
      },
      requestId: "00000000-0000-4000-8000-000000000002",
    },
  ],
  type: "object",
  additionalProperties: false,
  required: ["error", "requestId"],
  properties: {
    requestId: { type: "string" },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: {
        code: { type: "string", enum: Object.keys(messages) },
        message: { type: "string" },
        fields: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "code"],
            properties: { path: { type: "string" }, code: { type: "string" } },
          },
        },
      },
    },
  },
} as const;

export function registerErrors(
  app: FastifyInstance,
  audit?: (request: FastifyRequest, code: ErrorCode) => Promise<void>,
): void {
  app.addSchema(errorSchema);
  app.addHook("onRoute", (route) => {
    if (!route.schema || route.schema.hide) return;
    // These failures can originate before the route handler or while auditing
    // a rejection. Keep the shared error handler and its public contract aligned.
    route.schema.response = {
      ...Object.fromEntries(
        [400, 413, 415, 500, 503].map((status) => [
          status,
          { $ref: "ErrorResponse#" },
        ]),
      ),
      ...(typeof route.schema.response === "object"
        ? route.schema.response
        : {}),
    };
  });
  app.setNotFoundHandler(() => {
    throw new HttpError("NOT_FOUND");
  });
  app.setErrorHandler(async (error, request, reply) => {
    const failure =
      error instanceof Error ? (error as FastifyError) : undefined;
    let code: ErrorCode =
      error instanceof HttpError
        ? error.code
        : failure?.validation || failure?.statusCode === 400
          ? "INVALID_INPUT"
          : failure?.statusCode === 413
            ? "PAYLOAD_TOO_LARGE"
            : failure?.statusCode === 415
              ? "UNSUPPORTED_MEDIA_TYPE"
              : "INTERNAL_ERROR";
    if (audit) {
      try {
        await audit(request, code);
      } catch {
        // Never report a normally audited rejection when persistence failed.
        request.log.error({ code: "AUDIT_UNAVAILABLE" }, "Access audit failed");
        code = "UNAVAILABLE";
      }
    }
    const locale = language(request.headers["accept-language"]);
    // Do not serialize database errors, credentials, request bodies or cookies.
    if (statuses[code] >= 500) request.log.error({ code }, "Request failed");
    const fields = failure?.validation?.map((failure) => ({
      path: `${failure.instancePath}${typeof failure.params.missingProperty === "string" ? `/${failure.params.missingProperty}` : ""}`,
      code: failure.keyword,
    }));
    reply
      .header("content-language", locale)
      .code(statuses[code])
      .send({
        error: {
          code,
          message: messages[code][locale],
          ...(fields ? { fields } : {}),
        },
        requestId: request.id,
      });
  });
}
