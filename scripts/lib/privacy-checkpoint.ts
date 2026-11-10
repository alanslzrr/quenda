import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import type { Client, PoolClient } from "pg";

type Connection = Client | PoolClient;
const categories = new Set([
  "COMMUNICATIONS",
  "RESERVATIONS",
  "MUNICIPAL_PROFILE",
  "AUTHENTICATION",
  "IDENTITY",
  "AUTHORITY",
  "ACCREDITATIONS",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer = /^(0|[1-9][0-9]*)$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bounded = (value: unknown, limit: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= limit &&
  !value.includes("\0");
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const nullableUuid = (value: unknown) =>
  value === null || (typeof value === "string" && uuid.test(value));
const nullableText = (value: unknown, limit: number) =>
  value === null || bounded(value, limit);
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface SharedAuthorization {
  controllers: string[];
  reviews: Array<{
    reviewerTenantId: string;
    digest: string;
    actorId: string;
    authorizationReference: string;
    reason: string;
    reviewedAt: string;
  }>;
}
function validSharedAuthorization(value: unknown): boolean {
  if (value == null) return true; // Version 1 checkpoints predating shared reviews.
  if (
    !isRecord(value) ||
    !Array.isArray(value.controllers) ||
    !value.controllers.length ||
    new Set(value.controllers).size !== value.controllers.length ||
    value.controllers.some((id) => typeof id !== "string" || !uuid.test(id)) ||
    !Array.isArray(value.reviews) ||
    value.reviews.length !== value.controllers.length
  )
    return false;
  const reviewers = new Set<string>();
  let fingerprint: string | undefined;
  for (const review of value.reviews) {
    if (
      !isRecord(review) ||
      typeof review.reviewerTenantId !== "string" ||
      !value.controllers.includes(review.reviewerTenantId) ||
      reviewers.has(review.reviewerTenantId) ||
      typeof review.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(review.digest) ||
      (fingerprint !== undefined && fingerprint !== review.digest) ||
      !bounded(review.actorId, 128) ||
      !bounded(review.authorizationReference, 500) ||
      !bounded(review.reason, 500) ||
      !date(review.reviewedAt)
    )
      return false;
    reviewers.add(review.reviewerTenantId);
    fingerprint = review.digest;
  }
  return true;
}

export interface PrivacyCheckpoint {
  format: "quenda.privacy-checkpoint";
  version: 1;
  instanceId: string;
  generatedAt: string;
  ledgerHead: string;
  actions: {
    id: string;
    operation: "RETENTION_APPLIED" | "RIGHTS_ACTION_APPLIED";
    policyId: string | null;
    authorizationReference: string | null;
    actorId: string | null;
    reason: string | null;
    tenantId: string | null;
    category: string;
    targetKey: string;
    subjectId: string | null;
    action: "ERASE" | "BLOCK";
    cutoff: string;
    occurredAt: string;
    archiveId: string | null;
    destroyAfter: string | null;
    archiveDestroyed: boolean;
    sharedAuthorization?: SharedAuthorization | null;
  }[];
  holds: Record<string, unknown>[];
}

// Microseconds are exported as text rather than rounded through JavaScript Date.
// Source policy IDs survive replay without fabricating missing policy approvals.
const actionProjection = `e.id::text,e.operation,coalesce(e.policy_id::text,e.details->>'sourcePolicyId') AS "policyId",
 e.authorization_reference AS "authorizationReference",e.actor_id AS "actorId",e.reason,e.tenant_id AS "tenantId",e.category,e.target_key AS "targetKey",e.subject_id AS "subjectId",e.action,
 e.details->>'cutoff' AS cutoff,${utc("e.occurred_at")} AS "occurredAt",a.id AS "archiveId",${utc("a.destroy_after")} AS "destroyAfter",
 EXISTS(SELECT 1 FROM domain.retention_event d WHERE d.operation='ARCHIVE_DESTROYED' AND d.details->>'blockedEvent'=e.id::text) AS "archiveDestroyed",e.details->'sharedAuthorization' AS "sharedAuthorization"`;

function validateCheckpoint(
  value: unknown,
): asserts value is PrivacyCheckpoint {
  if (
    !isRecord(value) ||
    value.format !== "quenda.privacy-checkpoint" ||
    value.version !== 1 ||
    typeof value.instanceId !== "string" ||
    !uuid.test(value.instanceId) ||
    !date(value.generatedAt) ||
    typeof value.ledgerHead !== "string" ||
    !integer.test(value.ledgerHead) ||
    BigInt(value.ledgerHead) > 9223372036854775807n ||
    !Array.isArray(value.actions) ||
    !Array.isArray(value.holds)
  )
    throw new Error("Invalid privacy checkpoint");
  let previous = 0n;
  const archiveIds = new Set<string>();
  for (const action of value.actions) {
    if (
      !isRecord(action) ||
      typeof action.id !== "string" ||
      !integer.test(action.id) ||
      BigInt(action.id) <= previous ||
      BigInt(action.id) > BigInt(value.ledgerHead) ||
      !["RETENTION_APPLIED", "RIGHTS_ACTION_APPLIED"].includes(
        String(action.operation),
      ) ||
      !nullableUuid(action.policyId) ||
      !nullableText(action.authorizationReference, 500) ||
      !nullableText(action.actorId, 128) ||
      !nullableText(action.reason, 500) ||
      !nullableUuid(action.tenantId) ||
      !nullableText(action.subjectId, 128) ||
      typeof action.category !== "string" ||
      !categories.has(action.category) ||
      !bounded(action.targetKey, 500) ||
      !["ERASE", "BLOCK"].includes(String(action.action)) ||
      !date(action.cutoff) ||
      !date(action.occurredAt) ||
      typeof action.archiveDestroyed !== "boolean" ||
      !validSharedAuthorization(action.sharedAuthorization) ||
      !nullableUuid(action.archiveId) ||
      !(action.destroyAfter === null || date(action.destroyAfter)) ||
      (action.action === "ERASE" &&
        (action.archiveId !== null ||
          action.destroyAfter !== null ||
          action.archiveDestroyed)) ||
      (action.action === "BLOCK" &&
        !action.archiveDestroyed &&
        (!action.archiveId || !action.destroyAfter)) ||
      (action.archiveId !== null && archiveIds.has(String(action.archiveId)))
    )
      throw new Error("Invalid privacy checkpoint action");
    if (action.archiveId !== null) archiveIds.add(String(action.archiveId));
    previous = BigInt(action.id);
  }
  const holdIds = new Set<string>();
  for (const hold of value.holds) {
    if (
      !isRecord(hold) ||
      typeof hold.id !== "string" ||
      !uuid.test(hold.id) ||
      holdIds.has(hold.id) ||
      !nullableUuid(hold.tenant_id) ||
      typeof hold.category !== "string" ||
      !categories.has(hold.category) ||
      !nullableText(hold.target_key, 500) ||
      !nullableText(hold.subject_id, 128) ||
      (hold.target_key === null && hold.subject_id === null) ||
      !bounded(hold.authority_reference, 500) ||
      !bounded(hold.reason, 500) ||
      !bounded(hold.created_by, 128) ||
      !date(hold.created_at) ||
      hold.released_at !== null
    )
      throw new Error("Invalid privacy checkpoint hold");
    holdIds.add(hold.id);
  }
}

export async function exportPrivacyCheckpoint(client: Connection) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const metadata = (
      await client.query(
        "SELECT instance_id,clock_timestamp() AS instant,(SELECT coalesce(max(id),0)::text FROM domain.retention_event) AS head FROM domain.retention_control WHERE id",
      )
    ).rows[0];
    if (!metadata) throw new Error("Privacy metadata missing");
    const actions = (
      await client.query<PrivacyCheckpoint["actions"][number]>(`
      SELECT ${actionProjection} FROM domain.retention_event e LEFT JOIN domain.retention_archive a ON a.event_id=e.id
      WHERE e.operation IN ('RETENTION_APPLIED','RIGHTS_ACTION_APPLIED') ORDER BY e.id`)
    ).rows;
    const holds = (
      await client.query(
        `SELECT h.*,${utc("h.created_at")} AS created_at FROM domain.retention_hold h WHERE released_at IS NULL ORDER BY id`,
      )
    ).rows;
    const checkpoint: PrivacyCheckpoint = {
      format: "quenda.privacy-checkpoint",
      version: 1,
      instanceId: metadata.instance_id,
      generatedAt: metadata.instant.toISOString(),
      ledgerHead: metadata.head,
      actions,
      holds,
    };
    validateCheckpoint(checkpoint);
    await client.query("COMMIT");
    return checkpoint;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function writePrivacyCheckpoint(
  client: Connection,
  destination: string,
) {
  const document = JSON.stringify(await exportPrivacyCheckpoint(client));
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(document);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    path: destination,
    sha256: createHash("sha256").update(document).digest("hex"),
  };
}
export async function readPrivacyCheckpoint(file: string, expected: string) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Invalid checksum");
  const bytes = await readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("Privacy checkpoint checksum mismatch");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  validateCheckpoint(value);
  return value;
}

/** Replays verified suppression evidence, but never authorizes reopening. */
export async function reconcilePrivacyCheckpoint(
  client: Connection,
  checkpoint: PrivacyCheckpoint,
  checksum: string,
  recoveryReference: string,
) {
  validateCheckpoint(checkpoint);
  if (
    !/^[a-f0-9]{64}$/.test(checksum) ||
    !bounded(recoveryReference, 500) ||
    !recoveryReference.trim()
  )
    throw new Error("Recovery evidence and checksum required");
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const control = (
      await client.query(
        "SELECT * FROM domain.retention_control WHERE id FOR UPDATE",
      )
    ).rows[0];
    if (
      !control?.restore_review_required ||
      control.instance_id !== checkpoint.instanceId
    )
      throw new Error(
        "Only a closed restore of this instance can be reconciled",
      );
    // Prevent concurrent maintenance inserts from allocating IDs between the
    // sequence observation and advancement. Runtime traffic remains closed.
    await client.query(
      "LOCK TABLE domain.retention_event IN SHARE ROW EXCLUSIVE MODE",
    );
    const current = (
      await client.query(
        "SELECT id::text FROM domain.retention_event WHERE operation IN ('RETENTION_APPLIED','RIGHTS_ACTION_APPLIED')",
      )
    ).rows;
    const ids = new Set(checkpoint.actions.map((action) => action.id));
    if (current.some((row) => !ids.has(row.id)))
      throw new Error("Privacy checkpoint predates known actions");
    // Sequence advancement is non-transactional; a failure may leave gaps, never
    // reuses a source event ID. Advance before any generated audit insertion.
    await client.query(
      `SELECT setval(pg_get_serial_sequence('domain.retention_event','id'),greatest($1::bigint,coalesce((SELECT max(id) FROM domain.retention_event),0),coalesce(pg_sequence_last_value(pg_get_serial_sequence('domain.retention_event','id')::regclass),0),1),true)`,
      [checkpoint.ledgerHead],
    );
    await client.query(
      "UPDATE domain.retention_policy SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE revoked_at IS NULL AND superseded_at IS NULL",
    );
    let replayed = 0;
    for (const action of checkpoint.actions) {
      const existing = (
        await client.query(
          `SELECT ${actionProjection},
        coalesce(e.details->'sharedAuthorization','null'::jsonb)=$4::jsonb AS shared_matches,
        e.occurred_at=$2::timestamptz AS time_matches,(e.details->>'cutoff')::timestamptz=$3::timestamptz AS cutoff_matches
        FROM domain.retention_event e LEFT JOIN domain.retention_archive a ON a.event_id=e.id WHERE e.id=$1`,
          [
            action.id,
            action.occurredAt,
            action.cutoff,
            JSON.stringify(action.sharedAuthorization ?? null),
          ],
        )
      ).rows[0];
      if (
        existing &&
        (existing.operation !== action.operation ||
          existing.tenantId !== action.tenantId ||
          existing.category !== action.category ||
          existing.targetKey !== action.targetKey ||
          existing.subjectId !== action.subjectId ||
          existing.action !== action.action ||
          existing.policyId !== action.policyId ||
          existing.authorizationReference !== action.authorizationReference ||
          existing.actorId !== action.actorId ||
          existing.reason !== action.reason ||
          existing.time_matches !== true ||
          existing.shared_matches !== true ||
          existing.cutoff_matches !== true)
      )
        throw new Error(
          "Privacy ledger ID collision or inconsistent source evidence",
        );
      // Replay verified destruction, not a new retention decision. An expired
      // archive may remain under legal hold; the worker evaluates that later.
      const destroy = action.archiveDestroyed;
      if (existing?.archiveDestroyed && !destroy)
        throw new Error("Checkpoint predates known archive destruction");
      if (
        existing?.archiveId &&
        !destroy &&
        (existing.archiveId !== action.archiveId ||
          Date.parse(existing.destroyAfter) !==
            Date.parse(action.destroyAfter ?? ""))
      )
        throw new Error("Privacy archive metadata collision");
      const result = (
        await client.query<{ result: Record<string, unknown> }>(
          "SELECT domain.retention_apply($1,$2,$3,$4,$5,NULL,$6) AS result",
          [
            action.tenantId,
            action.category,
            action.targetKey,
            action.cutoff,
            action.action,
            !!action.sharedAuthorization,
          ],
        )
      ).rows[0]?.result;
      if (
        !result ||
        !["APPLIED", "ABSENT"].includes(String(result.status)) ||
        (result.status === "APPLIED" && result.subjectId !== action.subjectId)
      )
        throw new Error(
          "Restored data conflicts with suppression evidence; keep closed",
        );
      if (
        action.sharedAuthorization &&
        result.status === "APPLIED" &&
        isRecord(result.payload)
      )
        result.payload.sharedControllers =
          action.sharedAuthorization.controllers;
      if (!existing) {
        await client.query(
          `INSERT INTO domain.retention_event(id,operation,tenant_id,category,target_key,subject_id,action,authorization_reference,occurred_at,details,actor_id,reason)
          OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            action.id,
            action.operation,
            action.tenantId,
            action.category,
            action.targetKey,
            action.subjectId,
            action.action,
            action.authorizationReference,
            action.occurredAt,
            JSON.stringify({
              cutoff: action.cutoff,
              sharedAuthorization: action.sharedAuthorization ?? null,
              sourcePolicyId: action.policyId,
              restoredFromCheckpoint: checksum,
              recoveryReference,
            }),
            action.actorId,
            action.reason,
          ],
        );
      }
      if (action.action === "BLOCK") {
        if (destroy) {
          await client.query(
            "DELETE FROM domain.retention_archive WHERE event_id=$1",
            [action.id],
          );
          if (!existing?.archiveDestroyed)
            await client.query(
              `INSERT INTO domain.retention_event(operation,tenant_id,category,target_key,subject_id,action,authorization_reference,details)
            VALUES('ARCHIVE_DESTROYED',$1,$2,$3,$4,'ERASE',$5,$6)`,
              [
                action.tenantId,
                action.category,
                action.targetKey,
                action.subjectId,
                recoveryReference,
                JSON.stringify({
                  blockedEvent: action.id,
                  archiveId: action.archiveId,
                  checkpoint: checksum,
                }),
              ],
            );
        } else if (existing?.archiveId) {
          if (result.status === "APPLIED") {
            const same = (
              await client.query(
                "SELECT payload=$2::jsonb AS same FROM domain.retention_archive WHERE event_id=$1",
                [action.id, JSON.stringify(result.payload)],
              )
            ).rows[0]?.same;
            if (!same)
              throw new Error(
                "Restored target differs from retained blocked evidence",
              );
          }
        } else {
          if (
            result.status !== "APPLIED" ||
            result.payload === null ||
            result.payload === undefined
          )
            throw new Error(
              "Required blocked evidence missing; keep restore closed",
            );
          await client.query(
            `INSERT INTO domain.retention_archive(id,event_id,tenant_id,category,target_key,subject_id,payload,blocked_at,destroy_after)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              action.archiveId,
              action.id,
              action.tenantId,
              action.category,
              action.targetKey,
              action.subjectId,
              JSON.stringify(result.payload),
              action.occurredAt,
              action.destroyAfter,
            ],
          );
        }
      }
      if (!existing || result.status === "APPLIED") replayed++;
    }
    // Keep stale holds conservatively until independent review. Add new holds,
    // but never merge two unrelated authorizations sharing an identifier.
    for (const hold of checkpoint.holds) {
      const existing = (
        await client.query(
          `SELECT h.*,h.created_at=$2::timestamptz AS time_matches FROM domain.retention_hold h WHERE id=$1 FOR UPDATE`,
          [hold.id, hold.created_at],
        )
      ).rows[0];
      if (
        existing &&
        ([
          "tenant_id",
          "category",
          "target_key",
          "subject_id",
          "authority_reference",
          "reason",
          "created_by",
        ].some((field) => existing[field] !== hold[field]) ||
          !existing.time_matches)
      )
        throw new Error("Privacy hold ID collision");
      await client.query(
        `INSERT INTO domain.retention_hold(id,tenant_id,category,target_key,subject_id,authority_reference,reason,created_by,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET released_at=NULL`,
        [
          hold.id,
          hold.tenant_id,
          hold.category,
          hold.target_key,
          hold.subject_id,
          hold.authority_reference,
          hold.reason,
          hold.created_by,
          hold.created_at,
        ],
      );
    }
    await client.query(
      "UPDATE domain.retention_control SET privacy_replayed_at=clock_timestamp(),privacy_checkpoint_sha256=$1 WHERE id",
      [checksum],
    );
    await client.query("COMMIT");
    return {
      status: "PRIVACY_REPLAYED_REQUIRES_REVIEW" as const,
      replayed,
      reopeningAuthorized: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
