import type { AccountLabelValue } from "./account-label";
export const staffOperations = {
  CATALOG_CREATE: ["Crear catálogo", "Crear catálogo"],
  CATALOG_MANAGE: ["Gestionar catálogo", "Xestionar catálogo"],
  RESERVATION_READ: ["Consultar reservas", "Consultar reservas"],
  RESERVATION_MANAGE: ["Gestionar reservas", "Xestionar reservas"],
  UNIT_BLOCK: ["Bloquear unidades", "Bloquear unidades"],
  REPORT_READ: [
    "Consultar el uso de los espacios",
    "Consultar o uso dos espazos",
  ],
  DATA_EXPORT: ["Exportar datos", "Exportar datos"],
  PRIVACY_READ: ["Consultar datos personales", "Consultar datos persoais"],
  PRIVACY_EXECUTE: [
    "Ejecutar actuaciones de privacidad",
    "Executar actuacións de privacidade",
  ],
} satisfies Record<string, [string, string]>;
export type Operation = keyof typeof staffOperations;
export type Permission = { operation: Operation; unitId: string | null };
export function municipalOnly(operation: Operation) {
  return ["CATALOG_CREATE", "PRIVACY_READ", "PRIVACY_EXECUTE"].includes(
    operation,
  );
}
export function validPermissions(permissions: Permission[]) {
  return (
    permissions.length > 0 &&
    permissions.length <= 50 &&
    permissions.every(
      (p) =>
        p.operation in staffOperations &&
        (!municipalOnly(p.operation) || p.unitId === null),
    ) &&
    new Set(permissions.map((p) => JSON.stringify([p.operation, p.unitId])))
      .size === permissions.length
  );
}
/**
 * accountId is the account that accepted the invitation, or the account an
 * older invitation (or a scope replacement) was addressed to. recipientEmail
 * is the address of an invitation nobody has accepted yet. Both are null once
 * retention withdraws the address of an invitation that was never accepted.
 */
export type StaffInvitation = {
  invitationId: string;
  accountId: string | null;
  recipientEmail?: string | null;
  accountLabel?: AccountLabelValue;
  invitedByLabel?: AccountLabelValue;
  invitedBy: string;
  expiresAt: string;
  roleExpiresAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  replacesInvitationId?: string | null;
  permissions?: Permission[];
};
export type Administrator = {
  accountId: string;
  accountLabel?: AccountLabelValue;
  invitedByLabel?: AccountLabelValue;
  invitationId: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
};
// These are recorded events, not a client-side authorization decision.
export function invitationEvent(item: StaffInvitation, now = Date.now()) {
  if (item.revokedAt) return "REVOKED";
  if (item.acceptedAt) return "ACCEPTED";
  if (
    Date.parse(item.expiresAt) <= now ||
    (item.roleExpiresAt && Date.parse(item.roleExpiresAt) <= now)
  )
    return "EXPIRED";
  return "PENDING";
}
export function canReplace(item: StaffInvitation, now = Date.now()) {
  return (
    !!item.acceptedAt &&
    !item.revokedAt &&
    (!item.roleExpiresAt || Date.parse(item.roleExpiresAt) > now)
  );
}

/** Who the history names as recipient, without inferring any authority. */
export function invitationRecipient(
  item: Pick<StaffInvitation, "accountId" | "recipientEmail">,
):
  | { kind: "account"; accountId: string }
  | { kind: "address"; email: string }
  | { kind: "withdrawn" } {
  if (item.accountId) return { kind: "account", accountId: item.accountId };
  if (item.recipientEmail)
    return { kind: "address", email: item.recipientEmail };
  return { kind: "withdrawn" };
}
/**
 * A new invitation is addressed to an email; a scope replacement names no
 * recipient, because the server addresses it to the holder of the replaced
 * grant.
 */
export function staffInvitationBody(input: {
  kind: "manager" | "administrator";
  email: string;
  expiresAt: string;
  roleExpiresAt: string;
  permissions: Permission[];
  replacement?: Pick<StaffInvitation, "invitationId">;
  reason?: string;
}) {
  return {
    ...(input.replacement ? {} : { email: input.email.trim() }),
    expiresAt: input.expiresAt,
    roleExpiresAt: input.roleExpiresAt || null,
    ...(input.kind === "manager" ? { permissions: input.permissions } : {}),
    ...(input.replacement
      ? {
          replacesInvitationId: input.replacement.invitationId,
          reason: (input.reason ?? "").trim(),
        }
      : {}),
  };
}
