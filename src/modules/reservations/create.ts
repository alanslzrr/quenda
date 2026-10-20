import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool } from "pg";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import { validateReservableInterval } from "../catalog/index.ts";
import type { AuthenticatedAccount } from "../identity/index.ts";
import {
  type CreateReservationInput,
  normalizeReservationInput,
  reservationCommandInput,
} from "./input.ts";

export type { CreateReservationInput } from "./input.ts";

import { syncReservationConsumption } from "../collaboration/index.ts";
import { acceptConditions, completeAcceptanceEvidence } from "./acceptance.ts";
import { appendReservationEvent } from "./events.ts";

export async function createReservation(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  key: string,
  input: CreateReservationInput,
  correlationId: string,
  retentionSeconds: number,
  clock: Clock = systemClock,
) {
  const normalized = normalizeReservationInput(input);
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "reservation.create",
        key,
        input: reservationCommandInput(normalized),
        retentionSeconds,
        authorize: async (client) => {
          // The verified account may reserve for itself. Publication is a creation
          // rule, not a reason to hide an already committed result on replay.
          const municipality = await client.query(
            "SELECT id FROM domain.municipality WHERE id=$1",
            [tenantId],
          );
          if (!municipality.rowCount) throw new HttpError("NOT_FOUND");
        },
        execute: async (client) => {
          const policy = await validateReservableInterval(
            client,
            tenantId,
            normalized.unitId,
            normalized.startsAt,
            normalized.endsAt,
            clock.now().toISOString(),
          );
          const accepted = await acceptConditions(
            client,
            tenantId,
            normalized.unitId,
            normalized.startsAt,
            clock,
            normalized.acceptance,
          );
          await client.query(
            "INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [tenantId, actor.accountId],
          );
          const id = randomUUID();
          await client.query(
            `INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,cancellation_minutes,timezone,usage_rules_version,rules_accepted_at,booking_policy_version,conditions_accepted_at,non_cancellable_accepted,usage_rules_unit_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              tenantId,
              id,
              actor.accountId,
              normalized.unitId,
              policy.calendarVersion,
              normalized.startsAt,
              normalized.endsAt,
              accepted.cancellationMinutes,
              policy.timeZone,
              accepted.usageRulesVersion,
              accepted.rulesAcceptedAt,
              accepted.bookingPolicyVersion,
              accepted.conditionsAcceptedAt,
              accepted.nonCancellableAccepted,
              accepted.usageRulesUnitId,
            ],
          );
          await client.query(
            `INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) VALUES($1,$2,$3,$4,tstzrange($5,$6,'[)'))`,
            [
              tenantId,
              randomUUID(),
              normalized.unitId,
              id,
              normalized.startsAt,
              normalized.endsAt,
            ],
          );
          await syncReservationConsumption(client, id, correlationId);
          await appendReservationEvent(client, id, correlationId);
          const confirmedAt = clock.now().getTime();
          if (
            confirmedAt >= Date.parse(normalized.startsAt) ||
            (!accepted.nonCancellableAccepted &&
              confirmedAt >
                Date.parse(normalized.startsAt) -
                  accepted.cancellationMinutes * 60000)
          )
            throw new HttpError("CONDITIONS_CHANGED");
          return {
            tenantId,
            id,
            unitId: normalized.unitId,
            startsAt: normalized.startsAt,
            endsAt: normalized.endsAt,
            status: "CONFIRMADA",
            revision: 1,
            calendarVersion: policy.calendarVersion,
            cancellationMinutes: accepted.cancellationMinutes,
            usageRulesUnitId: accepted.usageRulesUnitId,
            pendingUsageRulesVersion: null,
            usageRulesVersion: accepted.usageRulesVersion,
            rulesAcceptedAt: accepted.rulesAcceptedAt?.toISOString() ?? null,
            bookingPolicyVersion: accepted.bookingPolicyVersion,
            conditionsAcceptedAt:
              accepted.conditionsAcceptedAt?.toISOString() ?? null,
            nonCancellableAccepted: accepted.nonCancellableAccepted,
            timeZone: policy.timeZone,
          };
        },
      },
    ).then((response) => ({
      ...response,
      result: completeAcceptanceEvidence(response.result),
    }));
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      ["23P01", "40001", "40P01"].includes(error.code ?? "")
    )
      throw new HttpError("CONFLICT");
    throw error;
  }
}
