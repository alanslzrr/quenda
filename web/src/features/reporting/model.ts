import { dateTimeFormat } from "../../ui/lib/intl-cache.ts";
export interface Authority {
  administrator: boolean;
  permissions: { operation: string; unitId: string | null }[];
}
export function allowed(m: Authority, operation: string, unit: string | null) {
  return (
    m.administrator ||
    m.permissions.some(
      (p) =>
        p.operation === operation && (p.unitId === null || p.unitId === unit),
    )
  );
}
export function canExport(m: Authority, unit: string | null) {
  return (
    allowed(m, "DATA_EXPORT", unit) &&
    (allowed(m, "RESERVATION_READ", unit) ||
      allowed(m, "RESERVATION_MANAGE", unit))
  );
}
export function canEnter(m: Authority, exporting = false) {
  const scopes = [null, ...m.permissions.map((p) => p.unitId)];
  return scopes.some((unit) =>
    exporting ? canExport(m, unit) : allowed(m, "REPORT_READ", unit),
  );
}
export function validPeriod(from: string, to: string) {
  const date = (v: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!date(from) || !date(to)) return false;
  const days =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    86400000;
  return days > 0 && days <= 366;
}
export type Monthly =
  | { status: "NOT_PUBLISHABLE" }
  | {
      status: "PUBLISHABLE";
      agreementId: string;
      month: string;
      revision: number;
      cutoff: string;
      controlVersion: number;
      reservations: number;
      reservedMinutes: number;
    };
export interface ReviewContext {
  agreementId: string;
  month: string;
  revision: number;
  recipientTenantId: string;
  recipientAccountId: string;
  historyDigest: string;
}
/** «julio de 2026»: a report month named as the month picker shows it. */
export function monthName(month: string, locale: string) {
  const [year, number] = month.split("-").map(Number);
  if (!year || !number || number < 1 || number > 12) return month;
  return dateTimeFormat(locale, { month: "long", year: "numeric" }).format(
    new Date(year, number - 1, 1),
  );
}
/** Whole minutes without decimals; a fraction keeps two. */
export const minuteDecimals = (minutes: number) =>
  Number.isInteger(minutes) ? 0 : 2;
