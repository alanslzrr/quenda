export interface Reservation {
  id: string;
  tenant_id: string;
  account_id: string;
  unit_id: string;
  starts_at: Date;
  ends_at: Date;
  status: "CONFIRMADA" | "CANCELADA";
  revision: number;
  calendar_version: number;
  cancellation_minutes: number;
  timezone: string;
  usage_rules_version: number | null;
  rules_accepted_at: Date | null;
  booking_policy_version: number | null;
  conditions_accepted_at: Date | null;
  non_cancellable_accepted: boolean | null;
}
export const present = (row: Omit<Reservation, "account_id">) => ({
  id: row.id,
  tenantId: row.tenant_id,
  unitId: row.unit_id,
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
  status: row.status,
  revision: row.revision,
  calendarVersion: row.calendar_version,
  cancellationMinutes: row.cancellation_minutes,
  timeZone: row.timezone,
  usageRulesVersion: row.usage_rules_version ?? null,
  rulesAcceptedAt: row.rules_accepted_at?.toISOString() ?? null,
  bookingPolicyVersion: row.booking_policy_version ?? null,
  conditionsAcceptedAt: row.conditions_accepted_at?.toISOString() ?? null,
  nonCancellableAccepted: row.non_cancellable_accepted ?? null,
});
