import { ApiError } from "../../app/api.ts";

const textField = (data: FormData, name: string) =>
  String(data.get(name) ?? "");
export function invitationDates(
  data: FormData,
  locale: "es" | "gl",
  optionalRole = false,
) {
  const expiresAt = textField(data, "expiresAt");
  const roleExpiresAt = textField(data, "roleExpiresAt");
  const valid = (date: string) =>
    Number.isFinite(Date.parse(date)) && Date.parse(date) > Date.now();
  if (
    !valid(expiresAt) ||
    (optionalRole &&
      textField(data, "roleExpiresAtEntered") &&
      !valid(roleExpiresAt))
  )
    throw new ApiError(
      400,
      "INVALID_INPUT",
      locale === "gl"
        ? "Revisa as datas e selecciona un desfase se a hora se repite."
        : "Revisa las fechas y selecciona un desfase si la hora se repite.",
    );
  return {
    expiresAt,
    ...(optionalRole ? { roleExpiresAt: roleExpiresAt || null } : {}),
  };
}
/** Body of the joint municipality creation with its first invitation. */
export function municipalityBody(
  data: FormData,
  timezone: string,
  locale: "es" | "gl",
) {
  return {
    name: textField(data, "name").trim(),
    timezone,
    administratorEmail: textField(data, "email").trim(),
    invitationExpiresAt: invitationDates(data, locale).expiresAt,
  };
}
/**
 * Body of the initial invitation replacement or the recovery invitation. Both
 * are addressed to an email; the server never looks the address up.
 */
export function continuityBody(
  data: FormData,
  locale: "es" | "gl",
  recovery: boolean,
) {
  return {
    email: textField(data, "email").trim(),
    ...invitationDates(data, locale),
    reason: textField(data, "reason").trim(),
    ...(recovery
      ? {
          verificationReference: textField(
            data,
            "verificationReference",
          ).trim(),
        }
      : {}),
  };
}
/**
 * Body of an operator or global privacy invitation. Both are addressed to an
 * email that the server never looks up; privacy adds permissions and reason.
 */
export function platformInvitationBody(
  data: FormData,
  locale: "es" | "gl",
  privacy: boolean,
  permissions: string[] = [],
) {
  return {
    email: textField(data, "email").trim(),
    ...invitationDates(data, locale, privacy),
    ...(privacy
      ? { permissions, reason: textField(data, "reason").trim() }
      : {}),
  };
}
/**
 * An operator names the compromised account by its exact email or by its
 * identifier. Both reach the same audited suspension; the email is only
 * trimmed here and normalised by the server.
 */
export function suspensionRequest(
  by: "email" | "account",
  value: string,
  reason: string,
) {
  const target = value.trim();
  return by === "email"
    ? {
        path: "/api/platform/account-suspensions",
        body: { email: target, reason: reason.trim() },
      }
    : {
        path: `/api/platform/accounts/${encodeURIComponent(target)}/suspend`,
        body: { reason: reason.trim() },
      };
}
/** Whether the operator is about to suspend the account of this session. */
export function suspendsOwnAccount(
  by: "email" | "account",
  value: string,
  own: { accountId: string; email: string } | null | undefined,
) {
  if (!own) return false;
  return by === "email"
    ? value.trim().toLowerCase() === own.email.trim().toLowerCase()
    : value.trim() === own.accountId;
}
export const statuses: Record<string, [string, string]> = {
  PENDING: ["Pendiente", "Pendente"],
  ACCEPTED: ["Aceptada", "Aceptada"],
  ACTIVE: ["Activa", "Activa"],
  REVOKED: ["Revocada", "Revogada"],
  EXPIRED: ["Vencida", "Vencida"],
  INVALIDATED: ["Invalidada", "Invalidada"],
};
export interface Operator {
  accountId: string;
  /** Name only; operators never see each other's e-mail. */
  accountName: string | null;
  grantedAt: string;
  revokedAt: string | null;
  active: boolean;
}
/**
 * accountId is the account that accepted, or the account an older invitation
 * was addressed to; recipientEmail is the address of an invitation nobody has
 * accepted yet. Both are null once retention withdraws that address.
 */
export interface Invitation {
  invitationId: string;
  accountId: string | null;
  recipientEmail?: string | null;
  accountName: string | null;
  invitedBy: string;
  invitedByName: string | null;
  status: string;
  expiresAt: string;
  roleExpiresAt?: string | null;
  permissions?: ("PRIVACY_READ" | "PRIVACY_EXECUTE")[];
  reason?: string;
}
