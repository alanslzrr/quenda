import { localInstants } from "../municipal/local-instants.ts";
export type Participant = {
  tenantId: string;
  accreditationIssuer: boolean;
  unitIds: string[];
};
export type Configuration = {
  startsAt: string;
  endsAt: string;
  purpose: string;
  legalBasis: string;
  responsibilities: string;
  retentionPolicy: string;
  eligibility: "acceso_abierto" | "acreditacion_vigente";
  weeklyLimit: number | null;
  aggregateReports: boolean;
  participants: Participant[];
};
export type AgreementSummary = {
  agreementId: string;
  name: string;
  timeZone: string;
  version: number;
  status: "BORRADOR" | "APROBADO" | "ACTIVADO" | "SUSPENDIDO";
  startsAt: string;
  endsAt: string;
};
export type Agreement = AgreementSummary &
  Configuration & {
    legalReviewReference: string | null;
    reportReviewReference: string | null;
    createdBy: string | null;
    createdAt: string;
    correlationId: string;
    approvals: {
      tenantId: string;
      /** Null for another municipality: only the approving municipality sees the account. */
      approvedBy: string | null;
      approvedAt: string;
      correlationId: string;
    }[];
  };
export const uuidPattern =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export function validParticipants(items: Participant[], own: string) {
  const uuid = new RegExp(`^${uuidPattern}$`);
  const tenants = items.map((p) => p.tenantId.toLowerCase());
  const units = items.flatMap((p) => p.unitIds.map((u) => u.toLowerCase()));
  return (
    tenants.includes(own.toLowerCase()) &&
    new Set(tenants).size === tenants.length &&
    new Set(units).size === units.length &&
    items.every(
      (p) => uuid.test(p.tenantId) && p.unitIds.every((u) => uuid.test(u)),
    )
  );
}
export function civilValue(instant: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  const minute = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  // Whole minutes read as hh:mm in the time field; finer precision is kept so
  // a cloned instant is not silently rounded.
  return parts.second === "00" && parts.fractionalSecond === "000"
    ? minute
    : `${minute}:${parts.second}.${parts.fractionalSecond}`;
}
export function civilOptions(value: string, zone: string) {
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/.exec(
      value,
    );
  if (!match) return [];
  try {
    const extra =
      Number(match[2] ?? 0) * 1000 + Number((match[3] ?? "0").padEnd(3, "0"));
    return localInstants(match[1], zone).map((x) => ({
      ...x,
      utc: new Date(Date.parse(x.utc) + extra).toISOString(),
    }));
  } catch {
    return [];
  }
}
export function validZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
    return !/^[+-]/.test(zone);
  } catch {
    return false;
  }
}
export const agreementPath = (tenant: string, id?: string, version?: number) =>
  `/administracion/${tenant}/convenios${id && version ? `/${id}/versiones/${version}` : ""}`;
