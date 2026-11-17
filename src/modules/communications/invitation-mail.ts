import type { MailMessage } from "../../shared/mail.ts";

export type InvitationMailKind =
  | "ADMINISTRATOR"
  | "MANAGER"
  | "OPERATOR"
  | "PRIVACY";
export interface InvitationMailEvent {
  kind: InvitationMailKind;
  /** Name of the municipality; null for platform invitations. */
  municipality: string | null;
  /** Zone the deadline is shown in: the municipality's, or UTC. */
  timeZone: string;
  /** Acceptance deadline of the invitation. */
  expiresAt: string;
}
const copy = {
  es: {
    subject: "Quenda — Invitación pendiente",
    ADMINISTRATOR: (place: string) => `administrar el municipio ${place}`,
    MANAGER: (place: string) => `gestionar el municipio ${place}`,
    OPERATOR: () => "operar la plataforma Quenda",
    PRIVACY: () =>
      "ejercer permisos de privacidad sobre la identidad global en Quenda",
    intro: (role: string) =>
      `Hay una invitación de Quenda dirigida a esta dirección de correo para ${role}.`,
    deadline: "Plazo para aceptarla",
    zone: "Zona horaria",
    steps:
      "Para aceptarla, inicia sesión en Quenda, o crea una cuenta, con esta misma dirección de correo, verifícala y activa la verificación en dos pasos. Después, acéptala en «Mi cuenta › Invitaciones»:",
    notice:
      "La invitación no concede ningún permiso hasta que se acepta. Si no la esperabas, puedes ignorar este mensaje.",
  },
  gl: {
    subject: "Quenda — Invitación pendente",
    ADMINISTRATOR: (place: string) => `administrar o municipio ${place}`,
    MANAGER: (place: string) => `xestionar o municipio ${place}`,
    OPERATOR: () => "operar a plataforma Quenda",
    PRIVACY: () =>
      "exercer permisos de privacidade sobre a identidade global en Quenda",
    intro: (role: string) =>
      `Hai unha invitación de Quenda dirixida a este enderezo de correo para ${role}.`,
    deadline: "Prazo para aceptala",
    zone: "Fuso horario",
    steps:
      "Para aceptala, inicia sesión en Quenda, ou crea unha conta, con este mesmo enderezo de correo, verifícao e activa a verificación en dous pasos. Despois, acéptaa en «A miña conta › Invitacións»:",
    notice:
      "A invitación non concede ningún permiso ata que se acepta. Se non a agardabas, podes ignorar esta mensaxe.",
  },
} as const;
const instant =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Pure rendering of the notice sent to an invited address. It is the same
 * whether or not an account uses that address: it names neither the inviter
 * nor an account, and carries no token. Acceptance stays in the application,
 * after signing in with this verified address and a second factor.
 */
export function invitationMail(
  to: string,
  origin: string,
  locale: "es" | "gl",
  event: InvitationMailEvent,
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
  const municipal = event.kind === "ADMINISTRATOR" || event.kind === "MANAGER";
  // A municipality name is shown on one line, whatever it contains.
  const place = event.municipality?.replace(/\s+/g, " ").trim() ?? "";
  if (
    !(locale === "es" || locale === "gl") ||
    !["ADMINISTRATOR", "MANAGER", "OPERATOR", "PRIVACY"].includes(event.kind) ||
    (municipal && (!place || place.length > 200)) ||
    !instant.test(event.expiresAt) ||
    !Number.isFinite(Date.parse(event.expiresAt))
  )
    throw new Error("Invalid invitation event");
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat(locale === "gl" ? "gl-ES" : "es-ES", {
      timeZone: event.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
  } catch {
    throw new Error("Invalid invitation event");
  }
  const label = copy[locale];
  const href = new URL("/perfil/invitaciones", base.origin).href;
  return {
    to,
    subject: label.subject,
    text: [
      label.intro(label[event.kind](place)),
      "",
      `${label.deadline}: ${format.format(new Date(event.expiresAt))}`,
      `${label.zone}: ${event.timeZone}`,
      "",
      label.steps,
      href,
      "",
      label.notice,
    ].join("\n"),
  };
}
