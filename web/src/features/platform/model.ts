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
export interface Invitation {
  invitationId: string;
  accountId: string;
  accountName: string | null;
  invitedBy: string;
  invitedByName: string | null;
  status: string;
  expiresAt: string;
  roleExpiresAt?: string | null;
  permissions?: ("PRIVACY_READ" | "PRIVACY_EXECUTE")[];
  reason?: string;
}
