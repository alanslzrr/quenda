import { randomUUID } from "node:crypto";
import { DatabaseError, type Pool } from "pg";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import { validateReservableInterval } from "../catalog/index.ts";
import {
  lockBookingAgreements,
  syncReservationConsumption,
} from "../collaboration/index.ts";
import {
  type AuthenticatedAccount,
  requirePermission,
} from "../identity/index.ts";
import { acceptConditions, completeAcceptanceEvidence } from "./acceptance.ts";
import { appendReservationEvent } from "./events.ts";
import {
  type CreateReservationInput,
  normalizeReservationInput,
  reservationCommandInput,
} from "./input.ts";
import { present, type Reservation } from "./state.ts";

export interface ModifyReservationInput extends CreateReservationInput {
  expectedRevision: number;
  administrative?: boolean;
  reason?: string;
}
export async function modifyReservation(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  reservationId: string,
  key: string,
  input: ModifyReservationInput,
  correlationId: string,
  retentionSeconds: number,
  clock: Clock = systemClock,
) {
  const normalized = normalizeReservationInput(input);
  const administrative = input.administrative ?? false;
  const reason = input.reason?.trim() ?? null;
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    (reason !== null && (reason.length < 1 || reason.length > 500)) ||
    (administrative && !reason)
  )
    throw new HttpError("INVALID_INPUT");
  let reservation: Reservation;
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "reservation.modify",
        key,
        input: {
          ...reservationCommandInput(normalized),
          reservationId,
          expectedRevision: input.expectedRevision,
          administrative,
          reason,
        },
        retentionSeconds,
        authorize: async (client) => {
          const found = await client.query<Reservation>(
            "SELECT * FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
            [tenantId, reservationId],
          );
          const row = found.rows[0];
          if (!row) throw new HttpError("NOT_FOUND");
          if (administrative)
            await requirePermission(
              client,
              actor,
              "RESERVATION_MANAGE",
              row.unit_id,
            );
          else if (row.account_id !== actor.accountId)
            throw new HttpError("FORBIDDEN");
          if (administrative)
            await requirePermission(
              client,
              actor,
              "RESERVATION_MANAGE",
              normalized.unitId,
            );
          reservation = row;
        },
        execute: async (client) => {
          await lockBookingAgreements(client, reservationId, normalized.unitId);
          const locked = await client.query<Reservation>(
            "SELECT * FROM domain.reservation WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [tenantId, reservationId],
          );
          if (!locked.rows[0]) throw new HttpError("NOT_FOUND");
          reservation = locked.rows[0];
          if (reservation.status !== "CONFIRMADA")
            throw new HttpError("CONFLICT");
          if (reservation.revision !== input.expectedRevision)
            throw new HttpError("CONFLICT");
          const now = clock.now().getTime();
          const deadline =
            reservation.starts_at.getTime() -
            (administrative ? 0 : reservation.cancellation_minutes * 60000);
          if (
            !Number.isFinite(now) ||
            now >= reservation.starts_at.getTime() ||
            now > deadline
          )
            throw new HttpError("RESERVATION_DEADLINE_PASSED");
          if (administrative && normalized.acceptance)
            throw new HttpError("HOLDER_ACCEPTANCE_REQUIRED");
          if (
            reservation.unit_id === normalized.unitId &&
            reservation.starts_at.toISOString() === normalized.startsAt &&
            reservation.ends_at.toISOString() === normalized.endsAt
          )
            return present(reservation);
          const policy = await validateReservableInterval(
            client,
            tenantId,
            normalized.unitId,
            normalized.startsAt,
            normalized.endsAt,
            new Date(now).toISOString(),
          );
          const accepted = await acceptConditions(
            client,
            tenantId,
            normalized.unitId,
            normalized.startsAt,
            clock,
            normalized.acceptance,
            reservation,
            administrative,
          );
          await client.query(
            "UPDATE domain.occupancy SET released_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2 AND released_at IS NULL",
            [tenantId, reservationId],
          );
          // Reused evidence stays in PostgreSQL: pg Date values lose microseconds.
          const updated = await client.query<Reservation>(
            `UPDATE domain.reservation SET unit_id=$3,starts_at=$4,ends_at=$5,calendar_version=$6,cancellation_minutes=$7,timezone=$8,usage_rules_version=$9,rules_accepted_at=CASE WHEN $16 THEN rules_accepted_at ELSE $10 END,booking_policy_version=$11,conditions_accepted_at=CASE WHEN $16 THEN conditions_accepted_at ELSE $12 END,non_cancellable_accepted=$13,usage_rules_unit_id=$14,pending_usage_rules_version=$15,revision=revision+1 WHERE tenant_id=$1 AND id=$2 RETURNING *`,
            [
              tenantId,
              reservationId,
              normalized.unitId,
              normalized.startsAt,
              normalized.endsAt,
              policy.calendarVersion,
              accepted.cancellationMinutes,
              policy.timeZone,
              accepted.usageRulesVersion,
              accepted.rulesAcceptedAt,
              accepted.bookingPolicyVersion,
              accepted.conditionsAcceptedAt,
              accepted.nonCancellableAccepted,
              accepted.usageRulesUnitId,
              accepted.pendingUsageRulesVersion,
              administrative || normalized.acceptance === null,
            ],
          );
          await client.query(
            `INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) VALUES($1,$2,$3,$4,tstzrange($5,$6,'[)'))`,
            [
              tenantId,
              randomUUID(),
              normalized.unitId,
              reservationId,
              normalized.startsAt,
              normalized.endsAt,
            ],
          );
          await syncReservationConsumption(
            client,
            reservationId,
            correlationId,
          );
          await appendReservationEvent(
            client,
            reservationId,
            correlationId,
            reason,
            administrative,
          );
          const confirmedAt = clock.now().getTime();
          if (
            confirmedAt >= reservation.starts_at.getTime() ||
            confirmedAt >= Date.parse(normalized.startsAt) ||
            confirmedAt > deadline
          )
            throw new HttpError("RESERVATION_DEADLINE_PASSED");
          if (
            !administrative &&
            !accepted.nonCancellableAccepted &&
            confirmedAt >
              Date.parse(normalized.startsAt) -
                accepted.cancellationMinutes * 60000
          )
            throw new HttpError("CONDITIONS_CHANGED");
          return present(updated.rows[0] as Reservation);
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
