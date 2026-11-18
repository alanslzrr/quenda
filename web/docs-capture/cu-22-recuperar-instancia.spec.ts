import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { access, Capture, expect, test } from "./capture";
import {
  type Command,
  closeSql,
  command,
  privacyMunicipality,
  profile,
  register,
} from "./people";

// CU-22 — Recuperar una instancia sin rehabilitar datos restringidos. El
// personal de operación copia la base, se suprime un perfil después de la
// copia, se guarda el checkpoint de privacidad, se restaura la copia en una
// base nueva y cerrada, se reproducen las supresiones posteriores y se revisa
// la base antes de cualquier reapertura. Todo se ejecuta con los comandos
// reales; la base restaurada se elimina al terminar y la instancia en uso no
// cambia salvo por el perfil suprimido de un municipio creado aquí.

test.afterAll(closeSql);

const target = "quenda_recuperada";
// The rejected restore names a destination of its own, so that it never reads
// as the one restored in step 3.
const unchecked = "quenda_recuperada_2";
const shown = "/directorio-privado";

test("CU-22 recuperar una instancia sin rehabilitar datos restringidos", async ({
  page,
}) => {
  test.setTimeout(420000);
  const cu = new Capture("CU-22");
  const bin = process.env.PG_BIN as string;
  const { databases } = await access();
  const restoredUrl = (base: string) => {
    const url = new URL(base);
    url.pathname = `/${target}`;
    return url.toString();
  };
  const restoredAdmin = restoredUrl(databases.administration);
  const restoredDomain = restoredUrl(databases.domain);
  const directory = await mkdtemp(path.join(os.tmpdir(), "quenda-cu22-"));
  const redact = { [directory]: shown };

  // Preparación: un municipio propio con una política aprobada y un vecino.
  const { tenantId, privacy } = await privacyMunicipality(
    "Concello de Castrelo Alto",
    ["Marcos Abal Fente", "marcos.abal@demo.test"],
    ["Raquel Iglesias Novo", "raquel.iglesias@demo.test"],
  );
  const martino = await register(
    "Martiño Couto Seoane",
    "martino.couto@demo.test",
    { mfa: false },
  );
  await profile(tenantId, martino.accountId, 60);
  expect(
    (
      await privacy.api.post(
        `/api/municipalities/${tenantId}/retention-policies`,
        {
          data: {
            category: "MUNICIPAL_PROFILE",
            retentionDays: 3650,
            action: "ERASE",
            purpose: "Gestión de la relación con el servicio deportivo",
            controllerReference: "Alcaldía de Castrelo Alto",
            approvalReference: "Resolución de alcaldía 2026/090",
            reason: "Registro de actividades de tratamiento",
          },
        },
      )
    ).status(),
  ).toBe(201);

  // Commands run in the order an operator would; the terminal images are
  // drawn afterwards in the order the guide shows them (main flow first).
  const shots: [string, Command][] = [];
  const dump = path.join(directory, "quenda-copia.dump");
  const journal = path.join(directory, "privacidad.json");
  const wrong = "0".repeat(64);
  const authorization = "Autorización de recuperación OP-2026/12";
  try {
    // Paso 1: copia lógica de la base de datos.
    const backup = await command(
      ["scripts/backup.ts", dump],
      { PG_BIN: bin, BACKUP_DATABASE_URL: databases.administration },
      `pnpm -s db:backup ${shown}/quenda-copia.dump | jq .`,
      redact,
      undefined,
      true,
    );
    expect(backup.code).toBe(0);
    shots.push(["copia", backup]);
    const { sha256: backupHash } = JSON.parse(backup.output) as {
      sha256: string;
    };

    // Después de la copia, el personal de privacidad suprime un perfil.
    const erased = await privacy.api.post(
      `/api/municipalities/${tenantId}/privacy-actions`,
      {
        data: {
          category: "MUNICIPAL_PROFILE",
          targetKey: martino.accountId,
          action: "ERASE",
          authorizationReference: "Solicitud de supresión RS-2026/601",
          reason: "Ejercicio del derecho de supresión",
        },
      },
    );
    expect(erased.ok(), await erased.text()).toBe(true);
    expect(((await erased.json()) as { status: string }).status).toBe(
      "APPLIED",
    );

    // Paso 2: checkpoint de privacidad, guardado fuera de las copias.
    const checkpoint = await command(
      ["scripts/privacy-checkpoint.ts", journal],
      { MIGRATION_DATABASE_URL: databases.migration },
      `pnpm -s privacy:checkpoint ${shown}/privacidad.json | jq .`,
      redact,
      undefined,
      true,
    );
    expect(checkpoint.code).toBe(0);
    shots.push(["checkpoint", checkpoint]);
    const { sha256: checkpointHash } = JSON.parse(checkpoint.output) as {
      sha256: string;
    };

    // Alternativa: un checksum que no coincide impide restaurar (se ejecuta
    // antes de crear la base para que el rechazo sea solo por el checksum).
    const restoreEnv = {
      PG_BIN: bin,
      RESTORE_ADMIN_DATABASE_URL: databases.administration,
    };
    const rejected = await command(
      ["scripts/restore.ts", dump, wrong, unchecked],
      restoreEnv,
      `pnpm -s db:restore ${shown}/quenda-copia.dump ${wrong} ${unchecked}`,
      redact,
    );
    expect(rejected.code).not.toBe(0);

    // Paso 3: restaurar en una base nueva, cerrada al acceso ordinario.
    const restored = await command(
      ["scripts/restore.ts", dump, backupHash, target],
      restoreEnv,
      `pnpm -s db:restore ${shown}/quenda-copia.dump ${backupHash} ${target} | jq .`,
      redact,
      undefined,
      true,
    );
    expect(restored.code).toBe(0);
    expect(restored.output).toContain("RESTORED_CLOSED");
    shots.push(["restaurar", restored]);

    // Paso 4: el rol de la aplicación no puede conectarse a la base restaurada.
    const psql = path.join(bin, "psql");
    const closed = await command(
      [restoredDomain, "-c", "SELECT 1"],
      { DOMAIN_DATABASE_URL: restoredDomain },
      `psql "$DOMAIN_DATABASE_URL" -c "SELECT 1"`,
      redact,
      psql,
    );
    expect(closed.code).not.toBe(0);
    // The database server of this machine is shown by a neutral name.
    closed.output = closed.output.replace(
      /"(?:127\.0\.0\.1|localhost|::1)", port \d+/g,
      '"db.interno", port 5432',
    );
    shots.push(["destino-cerrado", closed]);

    // Paso 5: la copia antigua conserva el perfil suprimido después de la copia.
    const queries = [
      `SELECT count(*) AS perfiles FROM domain.municipal_profile WHERE account_id='${martino.accountId}'`,
      "SELECT domain.privacy_operational() AS servicio_habilitado",
      `SELECT category, retention_days, revoked_at IS NOT NULL AS retirada FROM domain.retention_policy WHERE tenant_id='${tenantId}'`,
    ];
    const inspect = async () => {
      const result = await command(
        [restoredAdmin, ...queries.flatMap((query) => ["-c", query])],
        { RESTORE_ADMIN_DATABASE_URL: restoredAdmin },
        `psql "$RESTORE_ADMIN_DATABASE_URL" \\\n${queries
          .map((query) => `  -c "${query}"`)
          .join(" \\\n")}`,
        redact,
        psql,
      );
      expect(result.code).toBe(0);
      return result;
    };
    const before = await inspect();
    expect(before.output).toMatch(/perfiles\s*\n-+\n\s*1\n/);
    shots.push(["copia-antigua", before]);

    // Alternativa: un checkpoint que no coincide deja el destino cerrado.
    const reconcileEnv = { RESTORE_ADMIN_DATABASE_URL: restoredAdmin };
    const stale = await command(
      ["scripts/privacy-restore-reconcile.ts", journal, wrong, authorization],
      reconcileEnv,
      `pnpm -s privacy:restore-reconcile ${shown}/privacidad.json ${wrong} "${authorization}"`,
      redact,
    );
    expect(stale.code).not.toBe(0);

    // Paso 6: reproducir las actuaciones de privacidad posteriores a la copia.
    const replay = await command(
      [
        "scripts/privacy-restore-reconcile.ts",
        journal,
        checkpointHash,
        authorization,
      ],
      reconcileEnv,
      `pnpm -s privacy:restore-reconcile ${shown}/privacidad.json ${checkpointHash} "${authorization}" | jq .`,
      redact,
      undefined,
      true,
    );
    expect(replay.code).toBe(0);
    expect(replay.output).toContain('"reopeningAuthorized": false');
    shots.push(["reproducir-privacidad", replay]);

    // Paso 7: el perfil suprimido vuelve a faltar y la política queda retirada.
    const after = await inspect();
    expect(after.output).toMatch(/perfiles\s*\n-+\n\s*0\n/);
    shots.push(["tras-reproducir", after]);

    // Paso 8: conciliación de integridad antes de decidir la reapertura.
    const review = await command(
      ["scripts/reconcile.ts"],
      reconcileEnv,
      "pnpm -s db:reconcile | jq .",
      redact,
      undefined,
      true,
    );
    expect(review.output).toContain("CHECKED_REQUIRES_REVIEW");
    shots.push(["conciliar", review]);

    // Alternativas, en el orden de la guía.
    shots.push(["restaurar-checksum-erroneo", rejected]);
    shots.push(["checkpoint-no-coincide", stale]);
    for (const [slug, result] of shots)
      await cu.terminal(page, slug, result.shown, result.output);
  } finally {
    const admin = new pg.Client({
      connectionString: databases.administration,
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${target}`);
    await admin.query(`DROP DATABASE IF EXISTS ${unchecked}`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
