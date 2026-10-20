import { DatabaseError, type Pool } from "pg";
import { idempotentCommand } from "../../database/idempotency.ts";
import { HttpError } from "../../http/errors.ts";
import { type Clock, systemClock } from "../../shared/clock.ts";
import type { AuthenticatedAccount } from "../identity/index.ts";
import { appendReservationEvent } from "./events.ts";
import { present, type Reservation } from "./state.ts";

export interface AcceptUsageRulesInput {
  expectedRevision: number;
  unitId: string;
  usageRulesVersion: number;
}

// Consent changes evidence, never the booking's geometry, policy or consumption.
export async function acceptReservationUsageRules(
  pool: Pool,
  actor: AuthenticatedAccount,
  tenantId: string,
  reservationId: string,
  key: string,
  input: AcceptUsageRulesInput,
  correlationId: string,
  retentionSeconds: number,
  clock: Clock = systemClock,
) {
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    !Number.isInteger(input.usageRulesVersion) ||
    input.usageRulesVersion < 1 ||
    input.usageRulesVersion > 2147483647 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.unitId,
    )
  )
    throw new HttpError("INVALID_INPUT");
  const unitId = input.unitId.toLowerCase();
  try {
    return await idempotentCommand(
      pool,
      { accountId: actor.accountId, tenantId },
      {
        operation: "reservation.accept-usage-rules",
        key,
        input: {
          reservationId,
          expectedRevision: input.expectedRevision,
          unitId,
          usageRulesVersion: input.usageRulesVersion,
        },
        retentionSeconds,
        authorize: async (client) => {
          const row = (
            await client.query<Reservation>(
              "SELECT * FROM domain.reservation WHERE tenant_id=$1 AND id=$2",
              [tenantId, reservationId],
            )
          ).rows[0];
          if (!row) throw new HttpError("NOT_FOUND");
          if (row.account_id !== actor.accountId)
            throw new HttpError("FORBIDDEN");
        },
        execute: async (client) => {
          const row = (
            await client.query<Reservation>(
              "SELECT * FROM domain.reservation WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [tenantId, reservationId],
            )
          ).rows[0];
          if (!row) throw new HttpError("NOT_FOUND");
          if (row.account_id !== actor.accountId)
            throw new HttpError("FORBIDDEN");
          if (
            row.status !== "CONFIRMADA" ||
            row.revision !== input.expectedRevision
          )
            throw new HttpError("CONFLICT");
          const assertBeforeStart = () => {
            const now = clock.now().getTime();
            if (!Number.isFinite(now) || now >= row.starts_at.getTime())
              throw new HttpError("RESERVATION_DEADLINE_PASSED");
          };
          assertBeforeStart();
          if (row.unit_id !== unitId) throw new HttpError("CONDITIONS_CHANGED");
          if (row.pending_usage_rules_version === null) {
            if (
              row.usage_rules_unit_id === unitId &&
              row.usage_rules_version === input.usageRulesVersion
            )
              return present(row);
            throw new HttpError("CONDITIONS_CHANGED");
          }
          if (row.pending_usage_rules_version !== input.usageRulesVersion)
            throw new HttpError("CONDITIONS_CHANGED");
          const updated = (
            await client.query<Reservation>(
              `UPDATE domain.reservation SET usage_rules_unit_id=unit_id,
               usage_rules_version=pending_usage_rules_version,
               rules_accepted_at=clock_timestamp(),pending_usage_rules_version=NULL,
               revision=revision+1 WHERE tenant_id=$1 AND id=$2 RETURNING *`,
              [tenantId, reservationId],
            )
          ).rows[0] as Reservation;
          await appendReservationEvent(
            client,
            reservationId,
            correlationId,
            null,
            false,
            true,
          );
          assertBeforeStart();
          return present(updated);
        },
      },
    );
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      ["40001", "40P01"].includes(error.code ?? "")
    )
      throw new HttpError("CONFLICT");
    throw error;
  }
}
