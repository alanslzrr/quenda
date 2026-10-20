import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";

export async function reconcileRestore(client: Client, directory: string) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    // Event snapshots are serialized in UTC by the transactional audit functions.
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const role = await client.query(
      "SELECT rolsuper FROM pg_roles WHERE rolname=current_user",
    );
    if (role.rows[0]?.rolsuper !== true)
      throw new Error("Full administrative visibility required");
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const expected = await Promise.all(
      files.map(async (filename) => ({
        filename,
        sha256: createHash("sha256")
          .update(await readFile(path.join(directory, filename)))
          .digest("hex"),
      })),
    );
    const actual = (
      await client.query(
        "SELECT filename,sha256 FROM quenda_meta.migrations ORDER BY filename",
      )
    ).rows;
    const checks: Record<string, number> = {
      migrationHistory:
        JSON.stringify(actual) === JSON.stringify(expected) ? 0 : 1,
    };
    const queries: Record<string, string> = {
      reservationOccupancy: `SELECT count(*)::int AS n FROM domain.reservation r WHERE
        (r.status='CONFIRMADA' AND (SELECT count(*) FROM domain.occupancy o WHERE (o.tenant_id,o.reservation_id)=(r.tenant_id,r.id) AND o.released_at IS NULL AND o.unit_id=r.unit_id AND o.period=tstzrange(r.starts_at,r.ends_at,'[)'))<>1)
        OR (r.status='CANCELADA' AND EXISTS(SELECT 1 FROM domain.occupancy o WHERE (o.tenant_id,o.reservation_id)=(r.tenant_id,r.id) AND o.released_at IS NULL))`,
      blockOccupancy: `SELECT count(*)::int AS n FROM domain.schedule_block b WHERE
        (b.released_at IS NULL AND (SELECT count(*) FROM domain.occupancy o WHERE (o.tenant_id,o.block_id)=(b.tenant_id,b.id) AND o.released_at IS NULL AND o.unit_id=b.unit_id AND o.period=tstzrange(b.starts_at,b.ends_at,'[)'))<>1)
        OR (b.released_at IS NOT NULL AND EXISTS(SELECT 1 FROM domain.occupancy o WHERE (o.tenant_id,o.block_id)=(b.tenant_id,b.id) AND o.released_at IS NULL))`,
      missingAssignedConsumptions: `SELECT count(*)::int AS n FROM (
        SELECT DISTINCT a.agreement_id,r.tenant_id,r.id FROM domain.reservation r
        JOIN domain.agreement_assignment a ON (a.tenant_id,a.unit_id)=(r.tenant_id,r.unit_id)
        WHERE r.status='CONFIRMADA' AND upper(a.effective_period)>transaction_timestamp()
          AND a.effective_period @> tstzrange(r.starts_at,r.ends_at,'[)')
          AND NOT EXISTS(SELECT 1 FROM domain.agreement_consumption c
            WHERE (c.agreement_id,c.tenant_id,c.reservation_id)=(a.agreement_id,r.tenant_id,r.id) AND NOT c.released)
      ) missing`,
      missingConsumptions: `SELECT count(*)::int AS n FROM (
        SELECT DISTINCT e.agreement_id,e.tenant_id,e.reservation_id FROM domain.agreement_consumption_event e
        WHERE NOT EXISTS(SELECT 1 FROM domain.agreement_consumption c
          WHERE (c.agreement_id,c.tenant_id,c.reservation_id)=(e.agreement_id,e.tenant_id,e.reservation_id))
      ) missing`,
      missingConsumptionEvidence: `SELECT count(*)::int AS n FROM domain.agreement_consumption c
        WHERE NOT EXISTS(SELECT 1 FROM domain.agreement_consumption_event e
          WHERE (e.agreement_id,e.tenant_id,e.reservation_id)=(c.agreement_id,c.tenant_id,c.reservation_id))`,
      consumptionConsistency: `SELECT count(*)::int AS n FROM domain.agreement_consumption c
        JOIN domain.reservation r ON (r.tenant_id,r.id)=(c.tenant_id,c.reservation_id)
        JOIN domain.agreement_subject s ON (s.agreement_id,s.id)=(c.agreement_id,c.subject_id)
        JOIN domain.agreement a ON a.id=c.agreement_id
        WHERE s.account_id<>r.account_id OR c.week_start<>date_trunc('week',c.starts_at AT TIME ZONE a.timezone)::date
        OR (NOT c.released AND (r.status<>'CONFIRMADA' OR (c.unit_id,c.starts_at,c.ends_at) IS DISTINCT FROM (r.unit_id,r.starts_at,r.ends_at)))`,
      reservationAcceptance: `SELECT count(*)::int AS n FROM domain.reservation r WHERE NOT (
        ((r.usage_rules_unit_id IS NULL AND r.usage_rules_version IS NULL AND r.rules_accepted_at IS NULL)
          OR (r.usage_rules_unit_id IS NOT NULL AND r.usage_rules_version IS NOT NULL AND r.rules_accepted_at IS NOT NULL
            AND r.usage_rules_version>0 AND isfinite(r.rules_accepted_at)
            AND EXISTS(SELECT 1 FROM domain.unit_usage_rules u WHERE (u.tenant_id,u.unit_id,u.version)=(r.tenant_id,r.usage_rules_unit_id,r.usage_rules_version)
              AND u.text_content ~ '[^[:space:]]')))
        AND ((r.booking_policy_version IS NULL AND r.conditions_accepted_at IS NULL AND r.non_cancellable_accepted IS NULL)
          OR (r.booking_policy_version IS NOT NULL AND r.conditions_accepted_at IS NOT NULL AND r.non_cancellable_accepted IS NOT NULL
            AND r.booking_policy_version>0 AND isfinite(r.conditions_accepted_at)))
        AND (r.pending_usage_rules_version IS NULL OR (r.pending_usage_rules_version>0
          AND EXISTS(SELECT 1 FROM domain.unit_usage_rules u WHERE (u.tenant_id,u.unit_id,u.version)=(r.tenant_id,r.unit_id,r.pending_usage_rules_version)
            AND u.text_content ~ '[^[:space:]]'))))
      `,
      reservationSnapshots: `SELECT count(*)::int AS n FROM domain.reservation r
        CROSS JOIN LATERAL (SELECT e.revision,e.after_state FROM domain.reservation_event e
          WHERE (e.tenant_id,e.reservation_id)=(r.tenant_id,r.id) ORDER BY e.revision DESC LIMIT 1) latest
        WHERE latest.revision<>r.revision OR latest.after_state IS DISTINCT FROM
          domain.reservation_snapshot(r)
          - CASE WHEN NOT latest.after_state ?| ARRAY['usageRulesUnitId','pendingUsageRulesVersion']
              AND r.pending_usage_rules_version IS NULL
              AND ((r.usage_rules_unit_id IS NULL AND r.usage_rules_version IS NULL AND r.rules_accepted_at IS NULL)
                OR r.usage_rules_unit_id=r.unit_id)
            THEN ARRAY['usageRulesUnitId','pendingUsageRulesVersion'] ELSE ARRAY[]::text[] END
          - CASE WHEN NOT latest.after_state ?| ARRAY['usageRulesVersion','rulesAcceptedAt','bookingPolicyVersion','conditionsAcceptedAt','nonCancellableAccepted']
              AND r.usage_rules_version IS NULL AND r.rules_accepted_at IS NULL AND r.booking_policy_version IS NULL
              AND r.conditions_accepted_at IS NULL AND r.non_cancellable_accepted IS NULL
            THEN ARRAY['usageRulesVersion','rulesAcceptedAt','bookingPolicyVersion','conditionsAcceptedAt','nonCancellableAccepted']
            ELSE ARRAY[]::text[] END`,
      inactiveAccountSessions: `SELECT count(*)::int AS n FROM auth.session s JOIN auth.account_lifecycle a ON a.account_id=s."userId"
        WHERE a.deactivated_at IS NOT NULL OR a.suspended_at IS NOT NULL`,
      reservationEvents: `SELECT count(*)::int AS n FROM domain.reservation r WHERE
        (SELECT count(*) FROM domain.reservation_event e WHERE (e.tenant_id,e.reservation_id)=(r.tenant_id,r.id))<>r.revision
        OR NOT EXISTS(SELECT 1 FROM domain.reservation_event e WHERE (e.tenant_id,e.reservation_id,e.revision)=(r.tenant_id,r.id,r.revision)
          AND ((r.status='CANCELADA' AND e.kind='CANCELADA') OR (r.status='CONFIRMADA' AND e.kind IN ('CONFIRMADA','MODIFICADA','NORMAS_ACEPTADAS'))))`,
    };
    for (const [name, query] of Object.entries(queries))
      checks[name] = (await client.query(query)).rows[0].n;
    const mail = (
      await client.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE accepted_at IS NULL AND exhausted_at IS NULL)::int AS pending,
      count(*) FILTER(WHERE lease_token IS NOT NULL)::int AS leased,
      count(*) FILTER(WHERE accepted_at IS NOT NULL)::int AS accepted,
      count(*) FILTER(WHERE exhausted_at IS NOT NULL)::int AS exhausted FROM domain.reservation_email`)
    ).rows[0];
    const database = (
      await client.query(
        "SELECT current_database() AS name, datconnlimit FROM pg_database WHERE datname=current_database()",
      )
    ).rows[0];
    const privacy = (
      await client.query(
        'SELECT restore_review_required AS "reviewRequired",privacy_replayed_at AS "replayedAt",privacy_checkpoint_sha256 AS "checkpointSha256" FROM domain.retention_control WHERE id',
      )
    ).rows[0];
    await client.query("COMMIT");
    return {
      privacy,
      database: database.name,
      connectionLimit: database.datconnlimit,
      checks,
      mail,
      status: Object.values(checks).some((n) => n !== 0)
        ? "INCONSISTENT"
        : "CHECKED_REQUIRES_REVIEW",
      reopeningAuthorized: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
