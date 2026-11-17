import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { access, Capture, expect, signIn, test } from "./capture";
import {
  accountId,
  choose,
  chooseValue,
  pickMonth,
  ribasanta,
  secondBrowser,
  snap,
  sql,
  units,
  valdeira,
} from "./steps";

const run = promisify(execFile);
const root = path.resolve("..");

/** A closed month (`YYYY-MM`), `back` months before the current one. */
function closedMonth(back: number) {
  const now = new Date();
  const month = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1),
  );
  return month.toISOString().slice(0, 7);
}

/** Midnight in Madrid at the start of a `YYYY-MM` month, as an instant. */
function madridMonthStart(month: string) {
  const guess = new Date(`${month}-01T00:00:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid",
    timeZoneName: "longOffset",
  })
    .formatToParts(guess)
    .find((part) => part.type === "timeZoneName")
    ?.value.match(/GMT([+-])(\d{2}):(\d{2})/);
  const minutes = offset
    ? (offset[1] === "-" ? -1 : 1) *
      (Number(offset[2]) * 60 + Number(offset[3]))
    : 0;
  return new Date(guess.getTime() - minutes * 60000).toISOString();
}

/**
 * Precondition: an agreement between Valdeira and Ribasanta with aggregate
 * reports, effective during the whole closed month, and twelve people who
 * booked one hour in each municipality that month. It is recorded directly in
 * the database because an agreement activated today cannot cover a month that
 * has already closed. Its assignment ended with that month, so no unit stays
 * bound to it.
 */
async function agreementWithHistory(month: string) {
  const agreement = randomUUID();
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
  );
  // From Madrid midnight of the month to the end of the following one: the
  // following month has no bookings attributed to the agreement.
  const from = madridMonthStart(month);
  const to = madridMonthStart(
    new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 1))
      .toISOString()
      .slice(0, 7),
  );
  const marta = await accountId("administracion@valdeira.demo.test");
  const prefix = `informe-${month}-`;
  await sql(
    "auth",
    `INSERT INTO auth."user"(id,name,email,"emailVerified","updatedAt")
     SELECT $1||n, 'Persona usuaria '||n, $1||n||'@demo.test', true, now()
       FROM generate_series(1,12) n`,
    [prefix],
  );
  await sql(
    "migration",
    `WITH a AS (
       INSERT INTO domain.agreement(id,name,timezone,created_by,created_by_tenant)
       VALUES($1,'Ligas escolares comarcales','Europe/Madrid',$2,$3) RETURNING id)
     INSERT INTO domain.agreement_version(agreement_id,version,status,starts_at,ends_at,purpose,legal_basis,responsibilities,retention_policy,eligibility,weekly_limit,aggregate_reports,legal_review_reference,report_review_reference,created_by,correlation_id)
     SELECT id,1,'ACTIVADO',$4,$5,'Ligas escolares entre ambos municipios.','Convenio intermunicipal aprobado en pleno.','Cada municipio gestiona sus instalaciones.','Un año tras la vigencia.','acceso_abierto',NULL,true,'Informe de Secretaría 2026/071','Evaluación de riesgo 2026/071',$2,$6 FROM a`,
    [agreement, marta, valdeira, from, to, randomUUID()],
  );
  await sql(
    "migration",
    `INSERT INTO domain.agreement_activation(agreement_id,version,effective_period,activated_by,correlation_id)
     VALUES($1,1,tstzrange($2,$3,'[)'),$4,$5)`,
    [agreement, from, to, marta, randomUUID()],
  );
  await sql(
    "migration",
    "INSERT INTO domain.agreement_subject(agreement_id,id,account_id) SELECT $1,gen_random_uuid(),$2||n FROM generate_series(1,12) n",
    [agreement, prefix],
  );
  for (const [tenant, unit, hour] of [
    [valdeira, units.tennis, 16],
    [ribasanta, units.sportsCourt, 17],
  ] as const) {
    await sql(
      "migration",
      "INSERT INTO domain.municipal_profile(tenant_id,account_id) SELECT $1,$2||n FROM generate_series(1,12) n ON CONFLICT DO NOTHING",
      [tenant, prefix],
    );
    await sql(
      "migration",
      "INSERT INTO domain.agreement_participant VALUES($1,1,$2,false)",
      [agreement, tenant],
    );
    await sql(
      "migration",
      "INSERT INTO domain.agreement_unit VALUES($1,1,$2,$3)",
      [agreement, tenant, unit],
    );
    await sql(
      "migration",
      "INSERT INTO domain.agreement_assignment VALUES($1,1,$2,$3,tstzrange($4,$5,'[)'))",
      [agreement, tenant, unit, from, to],
    );
    await sql(
      "migration",
      `WITH bookings AS (
         INSERT INTO domain.reservation(tenant_id,id,account_id,unit_id,calendar_version,starts_at,ends_at,cancellation_minutes,timezone)
         SELECT $1,gen_random_uuid(),$3||n,$2,1,
                $4::timestamptz + (n*2) * interval '1 day' + $5::int * interval '1 hour',
                $4::timestamptz + (n*2) * interval '1 day' + ($5::int+1) * interval '1 hour',
                1440,'Europe/Madrid'
           FROM generate_series(1,12) n RETURNING *)
       INSERT INTO domain.occupancy(tenant_id,id,unit_id,reservation_id,period)
       SELECT tenant_id,gen_random_uuid(),unit_id,id,tstzrange(starts_at,ends_at,'[)') FROM bookings`,
      [tenant, unit, prefix, start.toISOString(), hour - 1],
    );
    await sql(
      "migration",
      `INSERT INTO domain.agreement_consumption(agreement_id,tenant_id,reservation_id,subject_id,attribution_version,unit_id,starts_at,ends_at,week_start)
       SELECT $1,r.tenant_id,r.id,s.id,1,r.unit_id,r.starts_at,r.ends_at,date_trunc('week',r.starts_at AT TIME ZONE 'Europe/Madrid')::date
         FROM domain.reservation r JOIN domain.agreement_subject s ON s.agreement_id=$1 AND s.account_id=r.account_id
        WHERE r.tenant_id=$2`,
      [agreement, tenant],
    );
    // The bookings carry the same evidence as booked ones, so a later
    // integrity reconciliation of this database finds them consistent.
    await sql(
      "migration",
      `INSERT INTO domain.reservation_event(tenant_id,id,reservation_id,revision,kind,actor_id,correlation_id,after_state,occurred_at)
       SELECT r.tenant_id,gen_random_uuid(),r.id,r.revision,'CONFIRMADA',r.account_id,gen_random_uuid(),domain.reservation_snapshot(r),r.created_at
         FROM domain.reservation r WHERE r.tenant_id=$1 AND r.account_id LIKE $2||'%'`,
      [tenant, prefix],
    );
    await sql(
      "migration",
      `INSERT INTO domain.agreement_consumption_event(id,agreement_id,subject_id,tenant_id,reservation_id,version,action,week_start,starts_at,ends_at,actor_id,correlation_id,occurred_at)
       SELECT gen_random_uuid(),c.agreement_id,c.subject_id,c.tenant_id,c.reservation_id,1,'ATTRIBUTED',c.week_start,c.starts_at,c.ends_at,r.account_id,gen_random_uuid(),r.created_at
         FROM domain.agreement_consumption c JOIN domain.reservation r ON (r.tenant_id,r.id)=(c.tenant_id,c.reservation_id)
        WHERE c.agreement_id=$1 AND c.tenant_id=$2`,
      [agreement, tenant],
    );
  }
  return agreement;
}

/** A report reader chooses the agreement by name among those with joint reports. */
async function agreementField(page: Page, agreement: string) {
  await chooseValue(page, "agreementId", "Convenio", agreement);
  return page.getByRole("combobox", { name: "Convenio", exact: true });
}

/** Requests the report, waiting out the per-account limit if it shows. */
async function consult(page: Page, agreement: string, month: string) {
  await page.goto(`/administracion/${valdeira}/informes`);
  await agreementField(page, agreement);
  await pickMonth(page, "Mes publicado", month);
  const submit = page.getByRole("button", { name: "Consultar informe" });
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/agreements/${agreement}/reports/${month}`) &&
      r.request().method() === "GET",
  );
  await submit.click();
  if ((await response).status() === 429) {
    await expect(page.getByRole("timer")).toHaveCount(0, { timeout: 65000 });
    await submit.click();
  }
  return submit;
}

/** A participant records its risk evaluation for one recipient. */
async function review(
  page: Page,
  tenant: string,
  agreement: string,
  month: string,
  recipient: string,
  decision: "Favorable" | "Desfavorable",
  cu?: Capture,
) {
  await page.goto(`/administracion/${tenant}/informes/revision`);
  await chooseValue(page, "agreementId", "Convenio", agreement);
  await chooseValue(page, "month", "Mes preparado", month);
  await chooseValue(
    page,
    "recipientTenantId",
    "Municipio destinatario",
    valdeira,
  );
  if (tenant === valdeira)
    await chooseValue(
      page,
      "recipientAccountId",
      "Persona destinataria",
      recipient,
    );
  else await page.getByLabel(/Referencia de cuenta facilitada/).fill(recipient);
  const context = page.getByRole("button", {
    name: "Consultar contexto de revisión",
    exact: true,
  });
  if (cu)
    await snap(cu, page, "revision-destinatario", {
      tall: true,
      target: context,
    });
  await context.click();
  await expect(
    page.getByRole("heading", { name: /Contexto de evaluación/ }),
  ).toBeVisible();
  await choose(page, "Decisión", decision);
  for (const label of [
    /Referencia de información auxiliar/,
    /Referencia de datos propios/,
    /Referencia de entregas anteriores/,
  ])
    await page
      .getByLabel(label)
      .fill("Acta de la comisión de seguimiento 2026/09");
  await page.getByRole("checkbox", { name: /Confirmo/ }).check();
  const record = page.getByRole("button", {
    name: "Registrar evaluación",
    exact: true,
  });
  if (cu)
    await snap(cu, page, "revision-evaluacion", { tall: true, target: record });
  await record.click();
  const done = page
    .getByRole("status")
    .filter({ hasText: "Revisión registrada" });
  await expect(done).toBeVisible();
  if (cu)
    await snap(cu, page, "revision-registrada", { tall: true, target: done });
}

// CU-18 — Consultar un informe conjunto. El gestor de Valdeira solicita el
// informe mensual de un convenio con informes agregados; las administraciones
// de Valdeira y Ribasanta registran su evaluación para él.
test("CU-18 consultar un informe conjunto", async ({ page, browser }) => {
  test.setTimeout(300000);
  const cu = new Capture("CU-18");
  const month = closedMonth(4);
  const following = closedMonth(3);
  const agreement = await agreementWithHistory(month);

  // Precondición: al cerrarse cada mes, Quenda prepara su agregado.
  const { databases } = await access();
  for (const closed of [month, following])
    await run(
      "node",
      ["src/monthly-report-worker.ts", agreement, closed, "0"],
      {
        cwd: root,
        env: { ...process.env, WORKER_DATABASE_URL: databases.worker },
      },
    );

  const brais = await accountId("xestion@valdeira.demo.test");
  await page.goto("/");
  const admins = await secondBrowser(browser, page);
  try {
    // Paso 1: cada administración participante evalúa el riesgo para él.
    const marta = await admins.newPage();
    await signIn(marta, "administrator");
    await review(marta, valdeira, agreement, month, brais, "Favorable", cu);
    const partner = await secondBrowser(browser, page);
    try {
      const xoan = await partner.newPage();
      await signIn(xoan, "partner");
      await review(xoan, ribasanta, agreement, month, brais, "Favorable");

      // Paso 2: el gestor solicita el informe de un convenio y un mes publicado.
      await signIn(page, "manager");
      await page
        .getByRole("navigation", { name: "Navegación principal" })
        .getByRole("link", { name: "Gestión", exact: true })
        .click();
      await page
        .getByRole("navigation", { name: "Gestión municipal" })
        .getByRole("link", { name: "Informes conjuntos", exact: true })
        .click();
      const field = await agreementField(page, agreement);
      await snap(cu, page, "identificador-convenio", { target: field });
      await pickMonth(page, "Mes publicado", month);
      const submit = page.getByRole("button", { name: "Consultar informe" });
      await snap(cu, page, "solicitar-informe", { target: submit });
      await submit.click();

      // Paso 3: con todas las evaluaciones favorables, el informe se entrega.
      const authorized = page.getByRole("heading", {
        name: "Informe autorizado",
        exact: true,
      });
      await expect(authorized).toBeVisible();
      await snap(cu, page, "informe-autorizado", {
        tall: true,
        target: authorized,
      });

      // Alternativa: un mes sin evaluación ni umbral es «no publicable».
      await consult(page, agreement, following);
      const blocked = page.getByRole("heading", { name: /No publicable/ });
      await expect(blocked).toBeVisible();
      await snap(cu, page, "no-publicable", { tall: true, target: blocked });

      // Alternativa: una evaluación desfavorable posterior impide la entrega.
      await review(xoan, ribasanta, agreement, month, brais, "Desfavorable");
      await consult(page, agreement, month);
      const withdrawn = page.getByRole("heading", { name: /No publicable/ });
      await expect(withdrawn).toBeVisible();
      await expect(page.getByRole("article")).toHaveCount(0);
      await snap(cu, page, "evaluacion-desfavorable", {
        tall: true,
        target: withdrawn,
      });
    } finally {
      await partner.close();
    }
  } finally {
    await admins.close();
  }
});
