import type { Pool } from "pg";
import type { MailTransport } from "../../shared/mail.ts";
import { type InvitationMailEvent, invitationMail } from "./invitation-mail.ts";
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
function validLimits(options: EmailWorkerOptions) {
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
}
/**
 * One attempt of the invitation notice queue, with the same lease, attempt
 * and retry limits as reservation mail. The message uses the process locale:
 * nothing about an account that might use the address is consulted.
 */
export async function processInvitationEmail(
  pool: Pool,
  transport: MailTransport,
  options: EmailWorkerOptions,
) {
  validLimits(options);
  // Autocommit claim, as for reservation mail: no client is held while sending.
  const result = await pool.query<{
    token: string;
    attempt: number;
    kind: InvitationMailEvent["kind"];
    recipient: string;
    municipality: string | null;
    timezone: string;
    expires_at: Date;
  }>("SELECT * FROM domain.claim_invitation_email($1,$2)", [
    options.leaseSeconds,
    options.maxAttempts,
  ]);
  const job = result.rows[0];
  if (!job) return "IDLE" as const;
  let accepted = false;
  try {
    await transport.send(
      invitationMail(job.recipient, options.origin, options.locale, {
        kind: job.kind,
        municipality: job.municipality,
        timeZone: job.timezone,
        expiresAt: job.expires_at.toISOString(),
      }),
    );
    accepted = true;
  } catch {
    // Neither the address nor provider errors are recorded or logged.
  }
  const finished = await pool.query<{ saved: boolean }>(
    "SELECT domain.finish_invitation_email($1,$2,$3,$4) AS saved",
    [job.token, accepted, options.maxAttempts, options.retrySeconds],
  );
  if (!finished.rows[0]?.saved) return "LEASE_LOST" as const;
  return accepted
    ? ("ACCEPTED" as const)
    : job.attempt >= options.maxAttempts
      ? ("EXHAUSTED" as const)
      : ("RETRY_SCHEDULED" as const);
}
export async function processReservationEmail(
  pool: Pool,
  transport: MailTransport,
  options: EmailWorkerOptions,
) {
  validLimits(options);
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
      administrative: boolean;
      actorName: string | null;
      reason: string | null;
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
          administrative: job.after_state.administrative,
          actorName: job.after_state.actorName,
          reason: job.after_state.reason,
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
