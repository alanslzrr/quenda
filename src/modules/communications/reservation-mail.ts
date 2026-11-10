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
}
const copy = {
  es: {
    CONFIRMADA: "Reserva confirmada",
    MODIFICADA: "Reserva modificada",
    CANCELADA: "Reserva cancelada",
    reservation: "Reserva",
    revision: "Revisión",
    event: "Fecha del evento",
    author: "Intervención administrativa de",
    unknownAuthor: "Administración municipal (nombre no registrado)",
    reason: "Motivo",
    start: "Inicio",
    end: "Fin",
    zone: "Zona horaria",
    historical:
      "Este mensaje describe el evento indicado. La reserva puede haber cambiado posteriormente.",
    current: "Consultar el estado actual",
    pendingRules: "Normas pendientes de aceptación en este cambio",
    rulesUnit: "Unidad de las normas",
    rulesVersion: "Versión de las normas",
    reviewRules:
      "Consulta el estado actual de la reserva para revisar y aceptar las normas que sigan pendientes.",
  },
  gl: {
    CONFIRMADA: "Reserva confirmada",
    MODIFICADA: "Reserva modificada",
    CANCELADA: "Reserva cancelada",
    reservation: "Reserva",
    revision: "Revisión",
    event: "Data do evento",
    author: "Intervención administrativa de",
    unknownAuthor: "Administración municipal (nome non rexistrado)",
    reason: "Motivo",
    start: "Inicio",
    end: "Fin",
    zone: "Fuso horario",
    historical:
      "Esta mensaxe describe o evento indicado. A reserva pode ter cambiado posteriormente.",
    current: "Consultar o estado actual",
    pendingRules: "Normas pendentes de aceptación neste cambio",
    rulesUnit: "Unidade das normas",
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
  const format = new Intl.DateTimeFormat(locale === "gl" ? "gl-ES" : "es-ES", {
    timeZone: event.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
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
      `${label.reservation}: ${event.reservationId}`,
      `${label.revision}: ${event.revision}`,
      `${label.event}: ${format.format(new Date(event.occurredAt))}`,
      ...(event.administrative
        ? [
            `${label.author}: ${event.actorName ?? label.unknownAuthor}`,
            `${label.reason}: ${event.reason ?? "—"}`,
          ]
        : []),
      `${label.start}: ${format.format(new Date(event.startsAt))}`,
      `${label.end}: ${format.format(new Date(event.endsAt))}`,
      `${label.zone}: ${event.timeZone}`,
      ...(event.kind === "MODIFICADA" && event.pendingUsageRulesVersion !== null
        ? [
            "",
            `${label.pendingRules}:`,
            `${label.rulesUnit}: ${event.unitId}`,
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
