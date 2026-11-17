import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";
import { DatabaseError } from "pg";

const messages = {
  SLOT_UNAVAILABLE: {
    es: "Este horario ya no está libre. Elige otro horario.",
    gl: "Este horario xa non está libre. Escolle outro horario.",
  },
  BOOKING_RULES_CHANGED: {
    es: "El horario solicitado no cumple las reglas vigentes. Consulta de nuevo la disponibilidad.",
    gl: "O horario solicitado non cumpre as regras vixentes. Consulta de novo a dispoñibilidade.",
  },
  QUOTA_EXCEEDED: {
    es: "Has alcanzado el límite semanal de reservas del convenio.",
    gl: "Acadaches o límite semanal de reservas do convenio.",
  },
  CREDENTIAL_REQUIRED: {
    es: "Necesitas una acreditación vigente que cubra toda la reserva. Contacta con tu ayuntamiento.",
    gl: "Precisas unha acreditación vixente que cubra toda a reserva. Contacta co teu concello.",
  },
  AGREEMENT_UNAVAILABLE: {
    es: "El convenio no permite reservar o modificar este horario en este momento.",
    gl: "O convenio non permite reservar ou modificar este horario neste momento.",
  },
  RESERVATION_CHANGED: {
    es: "La reserva ha cambiado. Consulta su estado actual antes de continuar.",
    gl: "A reserva cambiou. Consulta o seu estado actual antes de continuar.",
  },
  RESERVATION_CANCELLED: {
    es: "La reserva está cancelada y no se puede modificar.",
    gl: "A reserva está cancelada e non se pode modificar.",
  },
  COMMAND_IN_PROGRESS: {
    es: "La operación todavía se está procesando. Espera y recupera el resultado con la misma solicitud.",
    gl: "A operación aínda se está procesando. Agarda e recupera o resultado coa mesma solicitude.",
  },
  IDEMPOTENCY_KEY_REUSED: {
    es: "Esta referencia ya se utilizó para otra solicitud. Revisa la operación antes de iniciar una nueva.",
    gl: "Esta referencia xa se utilizou para outra solicitude. Revisa a operación antes de iniciar unha nova.",
  },

  PERSONAL_DATA_TOO_LARGE: {
    es: "El volumen de datos requiere una entrega por la vía administrativa. No se ha generado una descarga parcial por tamaño.",
    gl: "O volume de datos require unha entrega pola vía administrativa. Non se xerou unha descarga parcial por tamaño.",
  },
  ACCOUNT_PASSWORD_REQUIRED: {
    es: "Confirma tu contraseña actual para realizar esta operación.",
    gl: "Confirma o teu contrasinal actual para realizar esta operación.",
  },
  ACCOUNT_HANDOVER_REQUIRED: {
    es: "Debe quedar otro responsable habilitado con permiso indefinido antes de retirar esta responsabilidad.",
    gl: "Debe quedar outro responsable habilitado con permiso indefinido antes de retirar esta responsabilidade.",
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
    es: "No puedes dar de baja la cuenta mientras tengas reservas confirmadas futuras o en curso. Consulta tus reservas o contacta con el ayuntamiento.",
    gl: "Non podes dar de baixa a conta mentres teñas reservas confirmadas futuras ou en curso. Consulta as túas reservas ou contacta co concello.",
  },
  LOGO_INVALID: {
    es: "No se puede usar esta imagen como logo. Sube un PNG, JPG o WebP de hasta 2 MB, de al menos 32 píxeles por lado y no más de 4 veces más ancho que alto (ni al revés).",
    gl: "Non se pode usar esta imaxe como logo. Sube un PNG, JPG ou WebP de ata 2 MB, de polo menos 32 píxeles por lado e non máis de 4 veces máis ancho ca alto (nin ao revés).",
  },
  PHOTO_INVALID: {
    es: "No se puede usar esta imagen. Sube una foto horizontal en JPG, PNG o WebP de al menos 900 × 600 píxeles.",
    gl: "Non se pode usar esta imaxe. Sube unha foto horizontal en JPG, PNG ou WebP de polo menos 900 × 600 píxeles.",
  },
  PHOTO_LIMIT_REACHED: {
    es: "Ya hay 6 fotografías. Elimina una para añadir otra.",
    gl: "Xa hai 6 fotografías. Elimina unha para engadir outra.",
  },
  ACCOUNT_INACTIVE: {
    es: "La cuenta no está activa.",
    gl: "A conta non está activa.",
  },
  STALE_VERSION: {
    es: "Se han guardado otros cambios mientras editabas, quizá desde otra pestaña. Recarga para ver la versión actual y vuelve a aplicar tus cambios.",
    gl: "Gardáronse outros cambios mentres editabas, quizais desde outra lapela. Recarga para ver a versión actual e volve aplicar os teus cambios.",
  },
  SCHEDULE_HAS_RESERVATIONS: {
    es: "El nuevo horario dejaría fuera reservas confirmadas. Cancela o reubica esas reservas antes de guardarlo, o amplía el horario para cubrirlas.",
    gl: "O novo horario deixaría fóra reservas confirmadas. Cancela ou reubica esas reservas antes de gardalo, ou amplía o horario para cubrilas.",
  },
  UNIT_ADVANCE_EXCEEDS_LIMIT: {
    es: "Alguna unidad tiene en sus horarios una antelación mayor que el nuevo límite. Redúcela en esos horarios antes de bajar el límite municipal.",
    gl: "Algunha unidade ten nos seus horarios unha antelación maior que o novo límite. Redúcea neses horarios antes de baixar o límite municipal.",
  },
  FACILITY_NOT_PUBLISHED: {
    es: "La instalación de esta unidad no está publicada. Publícala antes de publicar la unidad.",
    gl: "A instalación desta unidade non está publicada. Publícaa antes de publicar a unidade.",
  },
  FACILITY_WITHDRAWN: {
    es: "La instalación está retirada y no admite unidades nuevas. Vuelve a publicarla antes de añadir unidades.",
    gl: "A instalación está retirada e non admite unidades novas. Volve publicala antes de engadir unidades.",
  },
  CATALOG_NOT_EMPTY: {
    es: "La importación solo se admite en un ayuntamiento sin instalaciones. Este ya tiene catálogo: modifícalo desde la gestión del catálogo.",
    gl: "A importación só se admite nun concello sen instalacións. Este xa ten catálogo: modifícao desde a xestión do catálogo.",
  },
  ARRIVAL_OUTSIDE_WINDOW: {
    es: "Solo se puede registrar la llegada de una reserva confirmada, desde 30 minutos antes de su inicio hasta que termina.",
    gl: "Só se pode rexistrar a chegada dunha reserva confirmada, desde 30 minutos antes do seu inicio ata que remata.",
  },
  AGREEMENT_STATE_CONFLICT: {
    es: "El convenio no admite esta operación en su estado actual. Recarga para revisar su versión, sus aprobaciones y su vigencia antes de repetirla.",
    gl: "O convenio non admite esta operación no seu estado actual. Recarga para revisar a súa versión, as súas aprobacións e a súa vixencia antes de repetila.",
  },
  ROLE_ALREADY_ACTIVE: {
    es: "La cuenta ya tiene este rol o una invitación pendiente para él. Recarga para ver su estado actual.",
    gl: "A conta xa ten este rol ou unha invitación pendente para el. Recarga para ver o seu estado actual.",
  },
  MUNICIPALITY_ALREADY_INITIALIZED: {
    es: "Este ayuntamiento ya completó su alta inicial y su invitación inicial no se puede sustituir. Si no queda ningún responsable habilitado, usa la recuperación de responsable.",
    gl: "Este concello xa completou a súa alta inicial e a súa invitación inicial non se pode substituír. Se non queda ningún responsable habilitado, usa a recuperación de responsable.",
  },
  ADMINISTRATOR_RECOVERY_UNAVAILABLE: {
    es: "No se puede recuperar el responsable: el ayuntamiento ya tiene un responsable habilitado o todavía no ha completado su alta inicial. Recarga para ver su estado actual.",
    gl: "Non se pode recuperar o responsable: o concello xa ten un responsable habilitado ou aínda non completou a súa alta inicial. Recarga para ver o seu estado actual.",
  },
  EMAIL_ADDRESS_UNAVAILABLE: {
    es: "No se puede cambiar a esta dirección de correo. Solicita el cambio con otra dirección.",
    gl: "Non se pode cambiar a este enderezo de correo. Solicita o cambio con outro enderezo.",
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
    es: "La situación ha cambiado y la operación no se ha completado. Recarga para ver el estado actual antes de repetirla.",
    gl: "A situación cambiou e a operación non se completou. Recarga para ver o estado actual antes de repetila.",
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
  SLOT_UNAVAILABLE: 409,
  BOOKING_RULES_CHANGED: 409,
  QUOTA_EXCEEDED: 409,
  CREDENTIAL_REQUIRED: 409,
  AGREEMENT_UNAVAILABLE: 409,
  RESERVATION_CHANGED: 409,
  RESERVATION_CANCELLED: 409,
  COMMAND_IN_PROGRESS: 409,
  IDEMPOTENCY_KEY_REUSED: 409,

  PERSONAL_DATA_TOO_LARGE: 409,
  ACCOUNT_PASSWORD_REQUIRED: 403,
  ACCOUNT_HANDOVER_REQUIRED: 409,
  USAGE_RULES_REQUIRED: 409,
  CONDITIONS_ACCEPTANCE_REQUIRED: 409,
  CONDITIONS_CHANGED: 409,
  HOLDER_ACCEPTANCE_REQUIRED: 409,
  RESERVATION_DEADLINE_PASSED: 409,
  ACCOUNT_HAS_FUTURE_RESERVATIONS: 409,
  ACCOUNT_INACTIVE: 403,
  PHOTO_INVALID: 400,
  LOGO_INVALID: 400,
  PHOTO_LIMIT_REACHED: 409,
  STALE_VERSION: 409,
  SCHEDULE_HAS_RESERVATIONS: 409,
  UNIT_ADVANCE_EXCEEDS_LIMIT: 409,
  FACILITY_NOT_PUBLISHED: 409,
  FACILITY_WITHDRAWN: 409,
  CATALOG_NOT_EMPTY: 409,
  ARRIVAL_OUTSIDE_WINDOW: 409,
  AGREEMENT_STATE_CONFLICT: 409,
  ROLE_ALREADY_ACTIVE: 409,
  MUNICIPALITY_ALREADY_INITIALIZED: 409,
  ADMINISTRATOR_RECOVERY_UNAVAILABLE: 409,
  EMAIL_ADDRESS_UNAVAILABLE: 409,

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

/**
 * Specific causes of what used to be a generic `CONFLICT`. The access audit
 * stores them under that outcome, so its closed vocabulary does not change.
 */
export const conflictCauses: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "STALE_VERSION",
  "SCHEDULE_HAS_RESERVATIONS",
  "UNIT_ADVANCE_EXCEEDS_LIMIT",
  "FACILITY_NOT_PUBLISHED",
  "FACILITY_WITHDRAWN",
  "CATALOG_NOT_EMPTY",
  "ARRIVAL_OUTSIDE_WINDOW",
  "AGREEMENT_STATE_CONFLICT",
  "ROLE_ALREADY_ACTIVE",
  "MUNICIPALITY_ALREADY_INITIALIZED",
  "ADMINISTRATOR_RECOVERY_UNAVAILABLE",
  "EMAIL_ADDRESS_UNAVAILABLE",
]);

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
        code: "STALE_VERSION",
        message:
          "Se han guardado otros cambios mientras editabas, quizá desde otra pestaña. Recarga para ver la versión actual y vuelve a aplicar tus cambios.",
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

// Contention that outlasted the bounded retries and the privacy restore
// barrier are temporary: the caller may repeat the request unchanged.
function transient(error: unknown): boolean {
  return (
    error instanceof DatabaseError &&
    ["40001", "40P01", "55000"].includes(error.code ?? "")
  );
}

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
              : transient(error)
                ? "UNAVAILABLE"
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
