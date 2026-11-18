import { Temporal } from "@js-temporal/polyfill";
import type { MailMessage } from "../../shared/mail.ts";

export interface ReservationMailEvent {
  tenantId: string;
  reservationId: string;
  revision: number;
  kind: "CONFIRMADA" | "MODIFICADA" | "CANCELADA";
  occurredAt: string;
  administrative?: boolean;
  actorName?: string | null;
  reason?: string | null;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  unitId: string;
  pendingUsageRulesVersion: number | null;
  /** Names read when the message is sent; absent ones are left out. */
  municipalityName?: string | null;
  facilityName?: string | null;
  unitName?: string | null;
}
const copy = {
  es: {
    CONFIRMADA: "Reserva confirmada",
    MODIFICADA: "Reserva modificada",
    CANCELADA: "Reserva cancelada",
    reference: "Referencia",
    municipality: "Municipio",
    facility: "Instalación",
    unit: "Espacio",
    event: "Fecha del evento",
    author: "Intervención administrativa de",
    unknownAuthor: "Administración municipal (nombre no registrado)",
    reason: "Motivo",
    start: "Inicio",
    end: "Fin",
    historical:
      "Este mensaje describe el evento indicado. La reserva puede haber cambiado posteriormente.",
    current: "Consultar el estado actual",
    pendingRules: "Normas pendientes de aceptación en este cambio",
    rulesUnit: "Espacio de las normas",
    rulesVersion: "Versión de las normas",
    reviewRules:
      "Consulta el estado actual de la reserva para revisar y aceptar las normas que sigan pendientes.",
  },
  gl: {
    CONFIRMADA: "Reserva confirmada",
    MODIFICADA: "Reserva modificada",
    CANCELADA: "Reserva cancelada",
    reference: "Referencia",
    municipality: "Municipio",
    facility: "Instalación",
    unit: "Espazo",
    event: "Data do evento",
    author: "Intervención administrativa de",
    unknownAuthor: "Administración municipal (nome non rexistrado)",
    reason: "Motivo",
    start: "Inicio",
    end: "Fin",
    historical:
      "Esta mensaxe describe o evento indicado. A reserva pode ter cambiado posteriormente.",
    current: "Consultar o estado actual",
    pendingRules: "Normas pendentes de aceptación neste cambio",
    rulesUnit: "Espazo das normas",
    rulesVersion: "Versión das normas",
    reviewRules:
      "Consulta o estado actual da reserva para revisar e aceptar as normas que sigan pendentes.",
  },
} as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instant =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

// Pure rendering: the outbox worker supplies persisted event data and performs
// delivery separately. Neither session state nor the booking is changed here.
export function reservationMail(
  to: string,
  origin: string,
  locale: "es" | "gl",
  event: ReservationMailEvent,
): MailMessage {
  const base = new URL(origin);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("Invalid application origin");
  if (
    !/^[^\s@]+@[^\s@]+$/.test(to) ||
    Array.from(to).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    to.length > 320
  )
    throw new Error("Invalid mail recipient");
  if (
    !(locale === "es" || locale === "gl") ||
    !["CONFIRMADA", "MODIFICADA", "CANCELADA"].includes(event.kind) ||
    !uuid.test(event.tenantId) ||
    !uuid.test(event.reservationId) ||
    !uuid.test(event.unitId) ||
    (event.pendingUsageRulesVersion !== null &&
      (!Number.isSafeInteger(event.pendingUsageRulesVersion) ||
        event.pendingUsageRulesVersion < 1)) ||
    !Number.isSafeInteger(event.revision) ||
    event.revision < 1
  )
    throw new Error("Invalid reservation event");
  const values = [event.occurredAt, event.startsAt, event.endsAt];
  if (
    values.some(
      (value) =>
        !instant.test(value) ||
        !Number.isFinite(Temporal.Instant.from(value).epochMilliseconds),
    ) ||
    Date.parse(event.startsAt) >= Date.parse(event.endsAt)
  )
    throw new Error("Invalid event interval");
  // Civil date and time where the space is, with the short zone name (CET,
  // CEST…) so that a time repeated by a clock change stays unambiguous.
  const format = new Intl.DateTimeFormat(locale === "gl" ? "gl-ES" : "es-ES", {
    timeZone: event.timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  // Catalogue names are single-line text; anything else would break a line.
  const name = (value: string | null | undefined) =>
    typeof value === "string" &&
    value.trim() &&
    !Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
      ? value.trim()
      : null;
  const places = [
    ["municipality", name(event.municipalityName)],
    ["facility", name(event.facilityName)],
    ["unit", name(event.unitName)],
  ] as const;
  const label = copy[locale];
  const href = new URL(
    `/reservas/${event.tenantId}/${event.reservationId}`,
    base.origin,
  ).href;
  return {
    to,
    subject: `Quenda — ${label[event.kind]}`,
    text: [
      label[event.kind],
      // The same short reference the reservation page shows.
      `${label.reference}: ${event.reservationId.slice(0, 8).toUpperCase()}`,
      ...places.flatMap(([key, value]) =>
        value ? [`${label[key]}: ${value}`] : [],
      ),
      `${label.start}: ${format.format(new Date(event.startsAt))}`,
      `${label.end}: ${format.format(new Date(event.endsAt))}`,
      `${label.event}: ${format.format(new Date(event.occurredAt))}`,
      ...(event.administrative
        ? [
            `${label.author}: ${event.actorName ?? label.unknownAuthor}`,
            `${label.reason}: ${event.reason ?? "—"}`,
          ]
        : []),
      ...(event.kind === "MODIFICADA" && event.pendingUsageRulesVersion !== null
        ? [
            "",
            `${label.pendingRules}:`,
            `${label.rulesUnit}: ${name(event.unitName) ?? event.unitId}`,
            `${label.rulesVersion}: ${event.pendingUsageRulesVersion}`,
            label.reviewRules,
          ]
        : []),
      "",
      label.historical,
      `${label.current}: ${href}`,
    ].join("\n"),
  };
}
