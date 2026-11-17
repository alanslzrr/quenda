export type Category =
  | "COMMUNICATIONS"
  | "RESERVATIONS"
  | "MUNICIPAL_PROFILE"
  | "AUTHENTICATION"
  | "IDENTITY"
  | "AUTHORITY"
  | "ACCREDITATIONS";
export const families: {
  value: Category;
  es: string;
  gl: string;
  global: boolean;
  municipal: boolean;
}[] = [
  {
    value: "COMMUNICATIONS",
    es: "Comunicaciones",
    gl: "Comunicacións",
    global: false,
    municipal: true,
  },
  {
    value: "RESERVATIONS",
    es: "Reservas",
    gl: "Reservas",
    global: false,
    municipal: true,
  },
  {
    value: "MUNICIPAL_PROFILE",
    es: "Perfiles municipales",
    gl: "Perfís municipais",
    global: false,
    municipal: true,
  },
  {
    value: "AUTHORITY",
    es: "Permisos e invitaciones",
    gl: "Permisos e invitacións",
    global: true,
    municipal: true,
  },
  {
    value: "ACCREDITATIONS",
    es: "Acreditaciones",
    gl: "Acreditacións",
    global: false,
    municipal: true,
  },
  {
    value: "AUTHENTICATION",
    es: "Autenticación",
    gl: "Autenticación",
    global: true,
    municipal: false,
  },
  {
    value: "IDENTITY",
    es: "Identidad global",
    gl: "Identidade global",
    global: true,
    municipal: false,
  },
];
/**
 * Families whose record reference in the municipal scope is the account
 * identifier itself: the municipal profile and the authority set of a person.
 */
export const accountKeyedFamily = (category: string) =>
  category === "MUNICIPAL_PROFILE" || category === "AUTHORITY";
/**
 * Privacy permissions never open the municipal directory: listing linked
 * people requires a current administrator of that municipality. Only when the
 * same actor already has that role can a privacy form offer the list, and the
 * global scope has no directory at all.
 */
export const directoryAvailable = (scope: {
  global: boolean;
  administrator: boolean;
}) => !scope.global && scope.administrator;
export const explicitPrivacy = (
  permissions: { operation: string; unitId: string | null }[],
  operation: string,
) => permissions.some((p) => p.operation === operation && p.unitId === null);
export function period(value: FormDataEntryValue | null) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 365000)
    throw new Error("Invalid period");
  return n;
}
export interface Policy {
  policyId: string;
  scopeTenantId: string | null;
  category: Category;
  retentionDays: number;
  action: "ERASE" | "BLOCK";
  blockDays: number | null;
  purpose: string;
  controllerReference: string;
  approvalReference: string;
  reason: string;
  approvedAt: string;
  revokedAt: string | null;
  supersededAt: string | null;
}
export interface Hold {
  holdId: string;
  category: Category;
  targetKey: string | null;
  subjectId: string | null;
  authorizationReference: string;
  reason: string;
  createdAt: string;
}
export interface RetentionStatus {
  holds: Hold[];
  conflicts: {
    policyId: string;
    category: Category;
    targetKey: string;
    reason: string;
    lastSeenAt: string;
  }[];
  hasMoreHolds: boolean;
  hasMoreConflicts: boolean;
}
export interface ActionResult {
  status: "APPLIED" | "CONFLICT" | "ABSENT";
  eventId: string;
  reason?: string;
}
export interface PersonalData {
  format: "quenda.personal-data";
  version: 1;
  scope: { kind: "MUNICIPAL" | "GLOBAL"; tenantId: string | null };
  completeness: {
    status: "PARTIAL";
    legalAccessResponseComplete: false;
    restrictedCategories: unknown[];
  };
  [key: string]: unknown;
}
