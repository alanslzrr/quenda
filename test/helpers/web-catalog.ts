import type { Pool } from "pg";
import { seedUsageRules } from "./usage-rules-fixture.ts";
export const webCatalog = {
  tenant: "00000000-0000-4000-8000-000000000101",
  facility: "00000000-0000-4000-8000-000000000102",
  unit: "00000000-0000-4000-8000-000000000103",
  otherUnit: "00000000-0000-4000-8000-000000000104",
};
export async function seedWebCatalog(
  auth: Pool,
  migration: Pool,
  catalog = webCatalog,
) {
  await auth.query(
    `INSERT INTO auth."user"(id,name,email,"emailVerified","updatedAt") VALUES('web-fixture','Synthetic operator','fixture@example.test',true,now()) ON CONFLICT (id) DO NOTHING`,
  );
  await migration.query(
    "INSERT INTO domain.municipality(id,name,timezone,cancellation_minutes) VALUES($1,'Oleiros de proba','Europe/Madrid',1440)",
    [catalog.tenant],
  );
  await migration.query(
    "INSERT INTO domain.facility(tenant_id,id,name,published_at) VALUES($1,$2,'Centro de proba',now())",
    [catalog.tenant, catalog.facility],
  );
  for (const [index, unit] of [catalog.unit, catalog.otherUnit].entries()) {
    await migration.query(
      "INSERT INTO domain.reservable_unit(tenant_id,id,facility_id,name) VALUES($1,$2,$3,$4)",
      [catalog.tenant, unit, catalog.facility, `Pista ${index + 1}`],
    );
    await migration.query(
      "INSERT INTO domain.unit_calendar_version(tenant_id,unit_id,version,minimum_minutes,maximum_minutes,step_minutes,weekly,exceptions,actor_id,reason) VALUES($1,$2,1,30,120,30,$3,'[]','web-fixture','Browser fixture')",
      [
        catalog.tenant,
        unit,
        JSON.stringify(
          Array.from({ length: 7 }, (_, i) => ({
            day: i + 1,
            startMinute: 0,
            endMinute: 1440,
          })),
        ),
      ],
    );
    await migration.query(
      "UPDATE domain.reservable_unit SET calendar_version=1 WHERE tenant_id=$1 AND id=$2",
      [catalog.tenant, unit],
    );
    await seedUsageRules(migration, catalog.tenant, unit, "web-fixture");
    await migration.query(
      "UPDATE domain.reservable_unit SET published_at=now() WHERE tenant_id=$1 AND id=$2",
      [catalog.tenant, unit],
    );
  }
}

export function browserCatalog(index: number) {
  const id = (suffix: number) =>
    `00000000-0000-4000-8000-${String(index * 100 + suffix).padStart(12, "0")}`;
  return { tenant: id(1), facility: id(2), unit: id(3), otherUnit: id(4) };
}
