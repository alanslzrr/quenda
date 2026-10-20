import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { transaction } from "../../src/database/transaction.ts";

export async function recoveryFixture(auth: Pool, migration: Pool) {
  await auth.query(
    'INSERT INTO auth."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES(\'citizen\',\'Citizen\',\'citizen@example.test\',true,now(),now())',
  );
  const tenants = [randomUUID(), randomUUID()],
    units = [randomUUID(), randomUUID()],
    agreement = randomUUID();
  for (let i = 0; i < 2; i++) {
    const facility = randomUUID();
    await migration.query(
      "INSERT INTO domain.municipality(id,name,timezone) VALUES($1,'Synthetic','Europe/Madrid')",
      [tenants[i]],
    );
    await migration.query(
      "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Facility',now())",
      [tenants[i], facility],
    );
    await migration.query(
      "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,'Unit')",
      [tenants[i], units[i], facility],
    );
    await migration.query(
      "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,30,120,30,$3,'[]','citizen','Fixture')",
      [
        tenants[i],
        units[i],
        JSON.stringify(
          Array.from({ length: 7 }, (_, n) => ({
            day: n + 1,
            startMinute: 0,
            endMinute: 1440,
          })),
        ),
      ],
    );
    await migration.query(
      "UPDATE domain.reservable_unit SET calendar_version=1,published_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenants[i], units[i]],
    );
  }
  // Approved/activated lifecycle fixture; booking commands themselves are real.
  await transaction(migration, async (c) => {
    await c.query(
      "INSERT INTO domain.agreement(id,name,timezone,created_by,created_by_tenant) VALUES($1,'Joint','Europe/Madrid','citizen',$2)",
      [agreement, tenants[0]],
    );
    await c.query(
      "INSERT INTO domain.agreement_version(agreement_id,version,status,starts_at,ends_at,purpose,legal_basis,responsibilities,retention_policy,eligibility,weekly_limit,aggregate_reports,created_by,correlation_id) VALUES($1,1,'ACTIVADO','2020-01-01T00:00:00Z','2040-01-01T00:00:00Z','Purpose','Reference','Municipal','Policy','acceso_abierto',1,false,'citizen',$2)",
      [agreement, randomUUID()],
    );
    await c.query(
      "INSERT INTO domain.agreement_activation(agreement_id,version,effective_period,activated_by,correlation_id) VALUES($1,1,'[2020-01-01T00:00:00Z,2040-01-01T00:00:00Z)','citizen',$2)",
      [agreement, randomUUID()],
    );
    for (let i = 0; i < 2; i++) {
      await c.query(
        "INSERT INTO domain.agreement_participant VALUES($1,1,$2,true)",
        [agreement, tenants[i]],
      );
      await c.query("INSERT INTO domain.agreement_unit VALUES($1,1,$2,$3)", [
        agreement,
        tenants[i],
        units[i],
      ]);
      await c.query(
        "INSERT INTO domain.agreement_assignment VALUES($1,1,$2,$3,'[2020-01-01T00:00:00Z,2040-01-01T00:00:00Z)')",
        [agreement, tenants[i], units[i]],
      );
      await c.query(
        "INSERT INTO domain.unit_agreement_gate VALUES($1,$2,$3,1)",
        [tenants[i], units[i], agreement],
      );
    }
  });

  return {
    tenants: tenants as [string, string],
    units: units as [string, string],
    agreement,
  };
}
