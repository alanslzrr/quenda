import type { FastifyError, FastifyInstance } from "fastify";

const messages = {
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
  INVALID_INPUT: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
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

export function registerErrors(app: FastifyInstance): void {
  app.addSchema(errorSchema);
  app.setNotFoundHandler(() => {
    throw new HttpError("NOT_FOUND");
  });
  app.setErrorHandler((error, request, reply) => {
    const failure =
      error instanceof Error ? (error as FastifyError) : undefined;
    const code =
      error instanceof HttpError
        ? error.code
        : failure?.validation || failure?.statusCode === 400
          ? "INVALID_INPUT"
          : failure?.statusCode === 413
            ? "PAYLOAD_TOO_LARGE"
            : failure?.statusCode === 415
              ? "UNSUPPORTED_MEDIA_TYPE"
              : "INTERNAL_ERROR";
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
