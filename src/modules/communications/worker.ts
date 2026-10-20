import type { Pool } from "pg";
import type { MailTransport } from "../../shared/mail.ts";
import {
  type ReservationMailEvent,
  reservationMail,
} from "./reservation-mail.ts";

export interface EmailWorkerOptions {
  origin: string;
  locale: "es" | "gl";
  leaseSeconds: number;
  maxAttempts: number;
  retrySeconds: number;
}
export async function processReservationEmail(
  pool: Pool,
  transport: MailTransport,
  options: EmailWorkerOptions,
) {
  if (
    !Number.isSafeInteger(options.leaseSeconds) ||
    options.leaseSeconds < 5 ||
    options.leaseSeconds > 3600 ||
    !Number.isSafeInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > 10 ||
    !Number.isSafeInteger(options.retrySeconds) ||
    options.retrySeconds < 1 ||
    options.retrySeconds > 86400
  )
    throw new Error("Invalid worker limits");
  // Autocommit completes the claim before any external I/O. No pooled client is
  // held while sending; a lost acknowledgement is recovered by lease expiry.
  const result = await pool.query<{
    token: string;
    locale: "es" | "gl" | null;
    attempt: number;
    recipient: string;
    tenant_id: string;
    reservation_id: string;
    revision: number;
    kind: ReservationMailEvent["kind"];
    occurred_at: Date;
    after_state: {
      startsAt: string;
      endsAt: string;
      timezone: string;
      unitId: string;
      pendingUsageRulesVersion?: number | null;
    };
  }>("SELECT * FROM domain.claim_reservation_email($1,$2)", [
    options.leaseSeconds,
    options.maxAttempts,
  ]);
  const job = result.rows[0];
  if (!job) return "IDLE" as const;
  let accepted = false;
  try {
    await transport.send(
      reservationMail(
        job.recipient,
        options.origin,
        job.locale ?? options.locale,
        {
          tenantId: job.tenant_id,
          reservationId: job.reservation_id,
          revision: job.revision,
          kind: job.kind,
          occurredAt: job.occurred_at.toISOString(),
          startsAt: job.after_state.startsAt,
          endsAt: job.after_state.endsAt,
          timeZone: job.after_state.timezone,
          unitId: job.after_state.unitId,
          pendingUsageRulesVersion:
            job.after_state.pendingUsageRulesVersion ?? null,
        },
      ),
    );
    accepted = true;
  } catch {
    // Provider errors may contain recipients or credentials. Persist only the
    // outcome; the caller receives a bounded status for operational alerting.
  }
  const finished = await pool.query<{ saved: boolean }>(
    "SELECT domain.finish_reservation_email($1,$2,$3,$4) AS saved",
    [job.token, accepted, options.maxAttempts, options.retrySeconds],
  );
  if (!finished.rows[0]?.saved) return "LEASE_LOST" as const;
  return accepted
    ? ("ACCEPTED" as const)
    : job.attempt >= options.maxAttempts
      ? ("EXHAUSTED" as const)
      : ("RETRY_SCHEDULED" as const);
}
