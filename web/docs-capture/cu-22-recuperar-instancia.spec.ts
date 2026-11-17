import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { access, Capture, expect, test } from "./capture";
import {
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

  try {
    // Paso 1: copia lógica de la base de datos.
    const backup = await command(
      ["scripts/backup.ts", path.join(directory, "quenda-copia.dump")],
      { PG_BIN: bin, BACKUP_DATABASE_URL: databases.administration },
      `PG_BIN=$PG_BIN BACKUP_DATABASE_URL=$BACKUP_DATABASE_URL node scripts/backup.ts ${shown}/quenda-copia.dump | jq .`,
      redact,
      undefined,
      true,
    );
    expect(backup.code).toBe(0);
    await cu.terminal(page, "copia", backup.shown, backup.output);
    const { sha256: backupHash } = JSON.parse(
      backup.output.replaceAll(shown, directory),
    ) as { sha256: string };

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
    expect((await erased.json()).status).toBe("APPLIED");

    // Paso 2: checkpoint de privacidad, guardado fuera de las copias.
    const checkpoint = await command(
      [
        "scripts/privacy-checkpoint.ts",
        path.join(directory, "privacidad.json"),
      ],
      { MIGRATION_DATABASE_URL: databases.migration },
      `MIGRATION_DATABASE_URL=$MIGRATION_DATABASE_URL node scripts/privacy-checkpoint.ts ${shown}/privacidad.json | jq .`,
      redact,
      undefined,
      true,
    );
    expect(checkpoint.code).toBe(0);
    await cu.terminal(page, "checkpoint", checkpoint.shown, checkpoint.output);
    const { sha256: checkpointHash } = JSON.parse(checkpoint.output) as {
      sha256: string;
    };

    // Alternativa: un checksum que no coincide impide restaurar.
    const restoreEnv = {
      PG_BIN: bin,
      RESTORE_ADMIN_DATABASE_URL: databases.administration,
    };
    const wrong = "0".repeat(64);
    const rejected = await command(
      [
        "scripts/restore.ts",
        path.join(directory, "quenda-copia.dump"),
        wrong,
        target,
      ],
      restoreEnv,
      `PG_BIN=$PG_BIN RESTORE_ADMIN_DATABASE_URL=$RESTORE_ADMIN_DATABASE_URL node scripts/restore.ts ${shown}/quenda-copia.dump ${wrong} ${target}`,
      redact,
    );
    expect(rejected.code).not.toBe(0);
    await cu.terminal(
      page,
      "restaurar-checksum-erroneo",
      rejected.shown,
      rejected.output,
    );

    // Paso 3: restaurar en una base nueva, cerrada al acceso ordinario.
    const restored = await command(
      [
        "scripts/restore.ts",
        path.join(directory, "quenda-copia.dump"),
        backupHash,
        target,
      ],
      restoreEnv,
      `PG_BIN=$PG_BIN RESTORE_ADMIN_DATABASE_URL=$RESTORE_ADMIN_DATABASE_URL node scripts/restore.ts ${shown}/quenda-copia.dump ${backupHash} ${target} | jq .`,
      redact,
      undefined,
      true,
    );
    expect(restored.code).toBe(0);
    expect(restored.output).toContain("RESTORED_CLOSED");
    await cu.terminal(page, "restaurar", restored.shown, restored.output);

    // El rol de la aplicación no puede conectarse a la base restaurada.
    const psql = path.join(bin, "psql");
    const closed = await command(
      [restoredDomain, "-c", "SELECT 1"],
      { DOMAIN_DATABASE_URL: restoredDomain },
      `psql "$DOMAIN_DATABASE_URL" -c "SELECT 1"`,
      redact,
      psql,
    );
    expect(closed.code).not.toBe(0);
    await cu.terminal(page, "destino-cerrado", closed.shown, closed.output);

    // La copia antigua conserva el perfil suprimido después de la copia.
    const inspect = (slug: string) =>
      command(
        [
          restoredAdmin,
          "-c",
          `SELECT count(*) AS perfiles FROM domain.municipal_profile WHERE account_id='${martino.accountId}'`,
          "-c",
          "SELECT domain.privacy_operational() AS servicio_habilitado",
          "-c",
          `SELECT category, retention_days, revoked_at IS NOT NULL AS retirada FROM domain.retention_policy WHERE tenant_id='${tenantId}'`,
        ],
        { RESTORE_ADMIN_DATABASE_URL: restoredAdmin },
        `psql "$RESTORE_ADMIN_DATABASE_URL" \\\n  -c "SELECT count(*) AS perfiles FROM domain.municipal_profile WHERE account_id='${martino.accountId}'" \\\n  -c "SELECT domain.privacy_operational() AS servicio_habilitado" \\\n  -c "SELECT category, retention_days, revoked_at IS NOT NULL AS retirada FROM domain.retention_policy WHERE tenant_id='${tenantId}'"`,
        redact,
        psql,
      ).then(async (result) => {
        expect(result.code).toBe(0);
        await cu.terminal(page, slug, result.shown, result.output);
        return result;
      });
    const before = await inspect("copia-antigua");
    expect(before.output).toMatch(/perfiles\s*\n-+\n\s*1\n/);

    // Alternativa: un checkpoint que no coincide deja el destino cerrado.
    const reconcileEnv = { RESTORE_ADMIN_DATABASE_URL: restoredAdmin };
    const stale = await command(
      [
        "scripts/privacy-restore-reconcile.ts",
        path.join(directory, "privacidad.json"),
        wrong,
        "Autorización de recuperación OP-2026/12",
      ],
      reconcileEnv,
      `RESTORE_ADMIN_DATABASE_URL=$RESTORE_ADMIN_DATABASE_URL node scripts/privacy-restore-reconcile.ts ${shown}/privacidad.json ${wrong} "Autorización de recuperación OP-2026/12"`,
      redact,
    );
    expect(stale.code).not.toBe(0);
    await cu.terminal(
      page,
      "checkpoint-no-coincide",
      stale.shown,
      stale.output,
    );

    // Paso 4: reproducir las actuaciones de privacidad posteriores a la copia.
    const replay = await command(
      [
        "scripts/privacy-restore-reconcile.ts",
        path.join(directory, "privacidad.json"),
        checkpointHash,
        "Autorización de recuperación OP-2026/12",
      ],
      reconcileEnv,
      `RESTORE_ADMIN_DATABASE_URL=$RESTORE_ADMIN_DATABASE_URL node scripts/privacy-restore-reconcile.ts ${shown}/privacidad.json ${checkpointHash} "Autorización de recuperación OP-2026/12" | jq .`,
      redact,
      undefined,
      true,
    );
    expect(replay.code).toBe(0);
    expect(replay.output).toContain('"reopeningAuthorized": false');
    await cu.terminal(
      page,
      "reproducir-privacidad",
      replay.shown,
      replay.output,
    );
    const after = await inspect("tras-reproducir");
    expect(after.output).toMatch(/perfiles\s*\n-+\n\s*0\n/);

    // Paso 5: conciliación de integridad antes de decidir la reapertura.
    const review = await command(
      ["scripts/reconcile.ts"],
      reconcileEnv,
      "RESTORE_ADMIN_DATABASE_URL=$RESTORE_ADMIN_DATABASE_URL node scripts/reconcile.ts | jq .",
      redact,
      undefined,
      true,
    );
    expect(review.output).toContain("CHECKED_REQUIRES_REVIEW");
    await cu.terminal(page, "conciliar", review.shown, review.output);
  } finally {
    const admin = new pg.Client({
      connectionString: databases.administration,
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${target}`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
