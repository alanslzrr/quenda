import type { AccountLabelValue } from "./account-label";
export const staffOperations = {
  CATALOG_CREATE: ["Crear catálogo", "Crear catálogo"],
  CATALOG_MANAGE: ["Gestionar catálogo", "Xestionar catálogo"],
  RESERVATION_READ: ["Consultar reservas", "Consultar reservas"],
  RESERVATION_MANAGE: ["Gestionar reservas", "Xestionar reservas"],
  UNIT_BLOCK: ["Bloquear unidades", "Bloquear unidades"],
  REPORT_READ: ["Consultar indicadores", "Consultar indicadores"],
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
export type StaffInvitation = {
  invitationId: string;
  accountId: string;
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
