import type { PoolClient } from "pg";
import { HttpError } from "../../http/errors.ts";
import type { Clock } from "../../shared/clock.ts";
import type { Reservation } from "./state.ts";

// Sending this object is an explicit acceptance of exactly these versions.
export interface ConditionsAcceptance {
  usageRulesVersion: number;
  bookingPolicyVersion: number;
  nonCancellable: boolean;
}
export const acceptanceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["usageRulesVersion", "bookingPolicyVersion", "nonCancellable"],
  properties: {
    usageRulesVersion: { type: "integer", minimum: 1, maximum: 2147483647 },
    bookingPolicyVersion: { type: "integer", minimum: 1, maximum: 2147483647 },
    nonCancellable: { type: "boolean" },
  },
} as const;
export const acceptanceProperties = {
  usageRulesVersion: { type: "integer", minimum: 1, nullable: true },
  rulesAcceptedAt: { type: "string", format: "date-time", nullable: true },
  bookingPolicyVersion: { type: "integer", minimum: 1, nullable: true },
  conditionsAcceptedAt: { type: "string", format: "date-time", nullable: true },
  nonCancellableAccepted: { type: "boolean", nullable: true },
} as const;
export function normalizeAcceptance(value: ConditionsAcceptance | undefined) {
  if (value === undefined) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !==
      "bookingPolicyVersion,nonCancellable,usageRulesVersion" ||
    !Number.isInteger(value.usageRulesVersion) ||
    value.usageRulesVersion < 1 ||
    value.usageRulesVersion > 2147483647 ||
    !Number.isInteger(value.bookingPolicyVersion) ||
    value.bookingPolicyVersion < 1 ||
    value.bookingPolicyVersion > 2147483647 ||
    typeof value.nonCancellable !== "boolean"
  )
    throw new HttpError("INVALID_INPUT");
  return {
    usageRulesVersion: value.usageRulesVersion,
    bookingPolicyVersion: value.bookingPolicyVersion,
    nonCancellable: value.nonCancellable,
  };
}
export async function acceptConditions(
  client: PoolClient,
  tenantId: string,
  unitId: string,
  startsAt: string,
  clock: Clock,
  acceptance: ConditionsAcceptance | null,
  previous?: Reservation,
  administrative = false,
) {
  const current = (
    await client.query<{
      usage_rules_version: number;
      booking_policy_version: number;
      cancellation_minutes: number;
    }>("SELECT * FROM domain.reservation_conditions($1,$2)", [tenantId, unitId])
  ).rows[0];
  if (!current)
    throw new HttpError(
      administrative
        ? "HOLDER_ACCEPTANCE_REQUIRED"
        : "CONDITIONS_ACCEPTANCE_REQUIRED",
    );
  if (administrative) {
    if (
      acceptance ||
      !previous?.usage_rules_version ||
      previous.unit_id !== unitId ||
      previous.usage_rules_version !== current.usage_rules_version
    )
      throw new HttpError("HOLDER_ACCEPTANCE_REQUIRED");
    return {
      usageRulesVersion: previous.usage_rules_version,
      bookingPolicyVersion: previous.booking_policy_version,
      cancellationMinutes: previous.cancellation_minutes,
      rulesAcceptedAt: previous.rules_accepted_at,
      conditionsAcceptedAt: previous.conditions_accepted_at,
      nonCancellableAccepted: previous.non_cancellable_accepted,
    };
  }
  const nonCancellable =
    clock.now().getTime() >
    Date.parse(startsAt) - current.cancellation_minutes * 60000;
  if (!acceptance) {
    if (
      !previous ||
      previous.unit_id !== unitId ||
      previous.usage_rules_version !== current.usage_rules_version ||
      previous.booking_policy_version !== current.booking_policy_version ||
      (nonCancellable && !previous.non_cancellable_accepted)
    )
      throw new HttpError("CONDITIONS_ACCEPTANCE_REQUIRED");
    return {
      usageRulesVersion: previous.usage_rules_version,
      bookingPolicyVersion: previous.booking_policy_version,
      cancellationMinutes: previous.cancellation_minutes,
      rulesAcceptedAt: previous.rules_accepted_at,
      conditionsAcceptedAt: previous.conditions_accepted_at,
      nonCancellableAccepted: previous.non_cancellable_accepted,
    };
  }
  if (
    acceptance.usageRulesVersion !== current.usage_rules_version ||
    acceptance.bookingPolicyVersion !== current.booking_policy_version ||
    acceptance.nonCancellable !== nonCancellable
  )
    throw new HttpError("CONDITIONS_CHANGED");
  const recordedAt = (
    await client.query<{ at: Date }>("SELECT clock_timestamp() AS at")
  ).rows[0]?.at;
  if (!recordedAt) throw new Error("Missing database time");
  return {
    usageRulesVersion: current.usage_rules_version,
    bookingPolicyVersion: current.booking_policy_version,
    cancellationMinutes: current.cancellation_minutes,
    rulesAcceptedAt: recordedAt,
    conditionsAcceptedAt: recordedAt,
    nonCancellableAccepted: nonCancellable,
  };
}

// Cached results created before explicit acceptance contain no such evidence.
// Complete their representation without inferring acceptance or consulting newer state.
interface AcceptanceEvidence {
  usageRulesVersion: number | null;
  rulesAcceptedAt: string | null;
  bookingPolicyVersion: number | null;
  conditionsAcceptedAt: string | null;
  nonCancellableAccepted: boolean | null;
}
export function completeAcceptanceEvidence<T extends object>(
  value: T,
): Omit<T, keyof AcceptanceEvidence> & AcceptanceEvidence {
  return {
    usageRulesVersion: null,
    rulesAcceptedAt: null,
    bookingPolicyVersion: null,
    conditionsAcceptedAt: null,
    nonCancellableAccepted: null,
    ...value,
  };
}
