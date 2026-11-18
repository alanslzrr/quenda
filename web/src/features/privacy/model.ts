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

/**
 * Reasons a retention cycle or an individual action leaves a record in place,
 * as people read them. The stored code stays in the audit trail; an unknown
 * code is shown as it is.
 */
const conflictReasons: Record<string, [es: string, gl: string]> = {
  ACTIVE_ACCREDITATION: [
    "Hay una acreditación vigente",
    "Hai unha acreditación vixente",
  ],
  ACTIVE_AUTHORITY: [
    "La persona conserva permisos vigentes",
    "A persoa conserva permisos vixentes",
  ],
  ACTIVE_RESERVATIONS: ["Hay reservas vigentes", "Hai reservas vixentes"],
  ARCHIVED_MUNICIPAL_EVIDENCE_REQUIRES_IDENTITY: [
    "Hay evidencias municipales archivadas que dependen de la identidad",
    "Hai evidencias municipais arquivadas que dependen da identidade",
  ],
  AUTHENTICATION_HOLD: [
    "La autenticación está bajo una excepción de conservación",
    "A autenticación está baixo unha excepción de conservación",
  ],
  COMMUNICATIONS_RETENTION: [
    "Las comunicaciones aún deben conservarse",
    "As comunicacións aínda deben conservarse",
  ],
  EMAIL_IN_FLIGHT: [
    "Hay un correo pendiente de envío",
    "Hai un correo pendente de envío",
  ],
  GLOBAL_SECURITY_SCOPE_REQUIRED: [
    "Requiere el ámbito global de seguridad",
    "Require o ámbito global de seguridade",
  ],
  IDEMPOTENCY_WINDOW: [
    "Hay una operación reciente que aún puede repetirse",
    "Hai unha operación recente que aínda pode repetirse",
  ],
  IDENTITY_EVIDENCE_HELD: [
    "Las evidencias de identidad están bajo una excepción de conservación",
    "As evidencias de identidade están baixo unha excepción de conservación",
  ],
  IDENTITY_NOT_DUE: [
    "La identidad aún no ha cumplido su plazo de conservación",
    "A identidade aínda non cumpriu o seu prazo de conservación",
  ],
  INCOMPLETE_AUTHENTICATION_AUDIT: [
    "La auditoría de autenticación está incompleta",
    "A auditoría de autenticación está incompleta",
  ],
  INVALID_SCOPE: [
    "El ámbito no corresponde a esta familia de datos",
    "O ámbito non corresponde a esta familia de datos",
  ],
  INVALID_TARGET: [
    "El registro indicado no admite esta actuación",
    "O rexistro indicado non admite esta actuación",
  ],
  LEGAL_HOLD: [
    "Hay una excepción de conservación activa",
    "Hai unha excepción de conservación activa",
  ],
  MUNICIPAL_EVIDENCE_REQUIRES_IDENTITY: [
    "Hay evidencias municipales que dependen de la identidad",
    "Hai evidencias municipais que dependen da identidade",
  ],
  MUNICIPAL_SCOPE_REQUIRED: [
    "Requiere el ámbito de un municipio",
    "Require o ámbito dun municipio",
  ],
  NOT_DUE: [
    "Aún no ha vencido el plazo de conservación",
    "Aínda non venceu o prazo de conservación",
  ],
  NOT_ELIGIBLE_OR_HELD: [
    "No procede o hay una excepción de conservación",
    "Non procede ou hai unha excepción de conservación",
  ],
  PROTECTED_DEPENDENCY: [
    "Otros datos protegidos dependen de este registro",
    "Outros datos protexidos dependen deste rexistro",
  ],
  RETAINED_REFERENCE: [
    "Una referencia compartida debe conservarse",
    "Unha referencia compartida debe conservarse",
  ],
  RETAINED_SERVICE_DEPENDENCIES: [
    "Datos del servicio que deben conservarse dependen de este registro",
    "Datos do servizo que deben conservarse dependen deste rexistro",
  ],
  SECURITY_REVIEW_REQUIRED: [
    "Requiere una revisión de seguridad",
    "Require unha revisión de seguridade",
  ],
  SHARED_CONTROLLER_REVIEW: [
    "Requiere la revisión de los corresponsables",
    "Require a revisión dos corresponsables",
  ],
};
export function conflictReason(code: string, locale: "es" | "gl") {
  const text = Object.hasOwn(conflictReasons, code)
    ? conflictReasons[code]
    : undefined;
  return text ? text[locale === "gl" ? 1 : 0] : code;
}
