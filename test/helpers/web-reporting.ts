import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { transaction } from "../../src/database/transaction.ts";
import { prepareMonthlyAssessment } from "../../src/modules/collaboration/monthly-assessment.ts";
import { seedMunicipalBrowser } from "./web-municipal.ts";
// Closed-month synthetic history is separate from interactive reservation fixtures.
// The real worker prepares the assessment; no publication review is pre-approved.
export async function seedReportingBrowser(
  app: FastifyInstance,
  auth: Pool,
  domain: Pool,
  migration: Pool,
  worker: Pool,
  index: number,
) {
  const a = await seedMunicipalBrowser(app, auth, domain, migration, index);
  const b = await seedMunicipalBrowser(app, auth, domain, migration, index + 1);
  const agreement = randomUUID(),
    month = "2024-03";
  const prefix = `reporting-${index}-`;
  await auth.query(
    `INSERT INTO auth."user"(id,name,email,"emailVerified","updatedAt") SELECT $1||n,'Synthetic',$1||n||'@example.test',true,now() FROM generate_series(0,9) n`,
    [prefix],
  );
  await transaction(migration, async (c) => {
    await c.query(
      "INSERT INTO domain.agreement(id,name,timezone,created_by,created_by_tenant) VALUES($1,'Reporting fixture','Europe/Madrid',$2,$3)",
      [agreement, a.accountId, a.tenant],
    );
    await c.query(
      "INSERT INTO domain.agreement_version(agreement_id,version,status,starts_at,ends_at,purpose,legal_basis,responsibilities,retention_policy,eligibility,weekly_limit,aggregate_reports,created_by,correlation_id) VALUES($1,1,'ACTIVADO','2024-02-29T23:00:00Z','2040-01-01T00:00:00Z','Synthetic purpose','Synthetic basis','Synthetic responsibilities','Synthetic policy','acceso_abierto',NULL,true,$2,$3)",
      [agreement, a.accountId, randomUUID()],
    );
    await c.query(
      "INSERT INTO domain.agreement_activation(agreement_id,version,effective_period,activated_by,correlation_id) VALUES($1,1,'[2024-02-29T23:00:00Z,2040-01-01T00:00:00Z)',$2,$3)",
      [agreement, a.accountId, randomUUID()],
    );
    await c.query(
      "INSERT INTO domain.agreement_subject(agreement_id,id,account_id) SELECT $1,gen_random_uuid(),$2||n FROM generate_series(0,9) n",
      [agreement, prefix],
    );
    for (const f of [a, b]) {
      await c.query(
        "INSERT INTO domain.municipal_profile(tenant_id,account_id) SELECT $1,$2||n FROM generate_series(0,9) n",
        [f.tenant, prefix],
      );
      await c.query(
        "INSERT INTO domain.agreement_participant VALUES($1,1,$2,false)",
        [agreement, f.tenant],
      );
      await c.query("INSERT INTO domain.agreement_unit VALUES($1,1,$2,$3)", [
        agreement,
        f.tenant,
        f.unit,
      ]);
      await c.query(
        "INSERT INTO domain.agreement_assignment VALUES($1,1,$2,$3,'[2024-02-29T23:00:00Z,2040-01-01T00:00:00Z)')",
        [agreement, f.tenant, f.unit],
      );
      await c.query(
        "WITH bookings AS (INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,cancellation_minutes,timezone) SELECT $1,gen_random_uuid(),$3||n,$2,1,timestamptz '2024-03-10T00:00:00Z'+n*interval '1 hour',timestamptz '2024-03-10T01:00:00Z'+n*interval '1 hour',60,'Europe/Madrid' FROM generate_series(0,9) n RETURNING *) INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period) SELECT tenant_id,gen_random_uuid(),unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM bookings",
        [f.tenant, f.unit, prefix],
      );
      await c.query(
        "INSERT INTO domain.agreement_consumption(agreement_id,tenant_id,reservation_id,subject_id,attribution_version,unit_id,starts_at,ends_at,week_start) SELECT $1,r.tenant_id,r.id,s.id,1,r.unit_id,r.starts_at,r.ends_at,date_trunc('week',r.starts_at AT TIME ZONE 'Europe/Madrid')::date FROM domain.reservation r JOIN domain.agreement_subject s ON s.agreement_id=$1 AND s.account_id=r.account_id WHERE r.tenant_id=$2",
        [agreement, f.tenant],
      );
    }
  });
  await prepareMonthlyAssessment(worker, agreement, month, 0);
  return { a, b, agreement, month };
}
